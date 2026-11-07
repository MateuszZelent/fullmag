"""Focused guards for the initial Compose pool-failure reconciler."""
from __future__ import annotations

import base64
import fcntl
import json
import os
import signal
import tempfile
import time
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
CONTROL_VOLUME = "own-control"
CONTROL_MOUNTPOINT = "/var/lib/docker/volumes/own-control/_data"
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


class RecreatedNetworkFailureTests(unittest.TestCase):
    def test_recreated_mode_requires_paired_pins_and_refuses_other_recovery_modes(self):
        base = dict(attempt=ATTEMPT, receipt_sha256="a" * 64, compose_sha256="b" * 64,
                    engine_id="engine", source_root="/source", recreation_attempt="c" * 32,
                    recreation_sha256="d" * 64, recover_absent_helper=False,
                    resume_prepared_sha256=None, recovery_id=None)
        for overrides in ({"recreation_sha256": None}, {"recreation_attempt": None},
                          {"recover_absent_helper": True}, {"recovery_id": "e" * 32},
                          {"resume_prepared_sha256": "f" * 64}):
            with self.subTest(overrides=overrides), patch.object(reconcile, "_identity_and_control") as identify:
                with self.assertRaises(BuildControlError):
                    reconcile.reconcile(SimpleNamespace(**{**base, **overrides}))
                identify.assert_not_called()

    def test_exact_owned_network_removal_then_pool_failure(self):
        prefix = f"Network {NETWORK} Removing\nNetwork {NETWORK} Removed\n"
        expected = reconcile.validate_pool_failure(COMPOSE_ERROR, NETWORK, PROJECT)
        self.assertEqual(reconcile.validate_pool_failure(prefix + COMPOSE_ERROR, NETWORK, PROJECT), expected)
        for bad in (prefix.replace(NETWORK, "foreign") + COMPOSE_ERROR,
                    f"Network {NETWORK} Removing\n" + COMPOSE_ERROR,
                    prefix + "unexpected\n" + COMPOSE_ERROR):
            with self.subTest(output=bad), self.assertRaises(BuildControlError):
                reconcile.validate_pool_failure(bad, NETWORK, PROJECT)


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


def foreign_container(**overrides):
    document = {
        "Id": "b" * 64,
        "Name": "/foreign-consumer",
        "Config": {"Labels": {}},
        "HostConfig": {"NetworkMode": "default"},
        "State": {"Running": True},
        "NetworkSettings": {"Networks": {}},
        "Mounts": [],
    }
    document.update(overrides)
    return document


def inventory_args(helper_id="a" * 64):
    return {
        "helper_id": helper_id,
        "helper_name": "fullmag-control-" + ATTEMPT,
        "project": PROJECT,
        "network_name": NETWORK,
        "identity": IDENTITY,
        "control_volume": CONTROL_VOLUME,
        "control_mountpoint": CONTROL_MOUNTPOINT,
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

    def test_vanishing_container_retries_full_inventory(self):
        error = BuildControlError("error: no such object: " + "c" * 64)
        with patch.object(reconcile, "_inspect_inventory_snapshot", side_effect=[error, [helper_doc()]]) as inspect:
            self.assertEqual(reconcile._container_inventory(), [helper_doc()])
            self.assertEqual(inspect.call_count, 2)

    def test_unrelated_checkout_windows_wsl_and_raw_binds_are_allowed_without_external_reads(self):
        helper = helper_doc()
        foreign = foreign_container(Mounts=[
            {"Type": "bind", "Source": IDENTITY["source_root"]},
            {"Type": "bind", "Source": "/work/fullmag/scripts"},
            {"Type": "bind", "Source": r"C:\git\foreign"},
            {"Type": "bind", "Source": r"\\wsl$\Ubuntu\home\foreign"},
            {"Type": "bind", "Source": "/run/desktop/mnt/host/e/git/foreign"},
            {"Type": "bind", "Source": "opaque-storage://foreign"},
            {"Type": "bind", "Source": CONTROL_MOUNTPOINT + "-sibling"},
            {"Type": "volume", "Name": "unrelated-volume"},
        ])
        modes = (
            ("live", [helper], inventory_args()),
            ("absent", [], inventory_args(helper_id=None)),
        )
        with (
            patch.object(reconcile, "docker_capture", side_effect=AssertionError("unexpected Docker call")),
            patch.object(reconcile, "bounded_capture", side_effect=AssertionError("unexpected host probe")),
        ):
            for mode, owned, args in modes:
                with self.subTest(mode=mode):
                    listed = reconcile.validate_container_inventory([*owned, foreign], **args)
                    expected = ([{"id": "a" * 64, "name": "fullmag-control-" + ATTEMPT,
                                  "service": "build-control"}] if mode == "live" else [])
                    self.assertEqual(listed, expected)

    def test_selected_project_identity_names_and_network_references_refuse_in_both_modes(self):
        helper = helper_doc()
        modes = (
            ("live", [helper], inventory_args()),
            ("absent", [], inventory_args(helper_id=None)),
        )
        identity_labels = {
            "org.fullmag.source.project-id": IDENTITY["project_id"],
            "org.fullmag.source.worktree-id": IDENTITY["worktree_id"],
            "org.fullmag.source.checkout-kind": IDENTITY["checkout_kind"],
            "org.fullmag.compose.project": PROJECT,
        }
        selected = (
            {"Config": {"Labels": {"com.docker.compose.project": PROJECT}}},
            {"Config": {"Labels": identity_labels}},
            {"Name": "/" + PROJECT + "-backend-1"},
            {"Name": "/" + PROJECT + "_frontend_1"},
        )
        for mode, owned, args in modes:
            for selection in selected:
                document = foreign_container(**selection, State={"Running": False})
                with self.subTest(mode=mode, selection=selection), self.assertRaises(BuildControlError):
                    reconcile.validate_container_inventory([*owned, document], **args)

            target_network = foreign_container(
                State={"Running": False},
                NetworkSettings={"Networks": {NETWORK: {}}},
            )
            with self.subTest(mode=mode, target_network=True), self.assertRaisesRegex(
                BuildControlError, "references the expected private network"
            ):
                reconcile.validate_container_inventory([*owned, target_network], **args)

    def test_control_volume_consumers_and_overlapping_daemon_binds_refuse_in_both_modes(self):
        helper = helper_doc()
        modes = (
            ("live", [helper], inventory_args()),
            ("absent", [], inventory_args(helper_id=None)),
        )
        overlaps = (
            CONTROL_MOUNTPOINT,
            "/var/lib/docker/volumes/own-control",
            CONTROL_MOUNTPOINT + "/nested",
        )
        for mode, owned, args in modes:
            for running in (False, True):
                volume_consumer = foreign_container(
                    State={"Running": running},
                    Mounts=[{"Type": "volume", "Name": CONTROL_VOLUME}],
                )
                with self.subTest(mode=mode, running=running), self.assertRaisesRegex(
                    BuildControlError, "control volume"
                ):
                    reconcile.validate_container_inventory([*owned, volume_consumer], **args)

            for source in overlaps:
                bind_consumer = foreign_container(
                    State={"Running": False},
                    Mounts=[{"Type": "bind", "Source": source}],
                )
                with self.subTest(mode=mode, source=source), self.assertRaisesRegex(
                    BuildControlError, "control volume"
                ):
                    reconcile.validate_container_inventory([*owned, bind_consumer], **args)

    def test_live_inventory_requires_exact_helper_and_absent_inventory_rejects_reappearing_helper(self):
        helper = helper_doc()
        unrelated = foreign_container(
            Id="f" * 64,
            Name="/another-checkout-helper",
            Config={"Labels": {
                "com.docker.compose.project": "another-project",
                "com.docker.compose.service": "build-control",
                "org.fullmag.source.project-id": IDENTITY["project_id"],
                "org.fullmag.source.worktree-id": "another-worktree",
                "org.fullmag.source.checkout-kind": "worktree",
                "org.fullmag.compose.project": "another-project",
            }},
            HostConfig={"NetworkMode": "none"},
        )
        self.assertEqual(
            reconcile.validate_container_inventory([helper, unrelated], **inventory_args()),
            [{"id": "a" * 64, "name": "fullmag-control-" + ATTEMPT,
              "service": "build-control"}],
        )
        with self.assertRaises(BuildControlError):
            reconcile.validate_container_inventory([unrelated], **inventory_args())

        absent_args = inventory_args(helper_id=None)
        self.assertEqual(reconcile.validate_container_inventory([], **absent_args), [])
        for state in ({"Running": True}, {"Running": False}):
            selected_helper = {**helper, "State": state}
            with self.subTest(state=state), self.assertRaises(BuildControlError):
                reconcile.validate_container_inventory([selected_helper], **absent_args)

    def test_vanishing_container_retries_full_inventory(self):
        error = BuildControlError("error: no such object: " + "c" * 64)
        with patch.object(reconcile, "_inspect_inventory_snapshot", side_effect=[error, [helper_doc()]]) as inspect:
            self.assertEqual(reconcile._container_inventory(), [helper_doc()])
            self.assertEqual(inspect.call_count, 2)

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

class AbsentHelperEvidenceTests(unittest.TestCase):
    def test_volume_refusal_precedes_any_control_mount(self):
        control = SimpleNamespace(volume="selected-control", shared_labels={"owner": "selected"})
        volume = {"Name": "selected-control", "Driver": "local", "Options": None,
                  "Labels": {"owner": "foreign"}, "Mountpoint": CONTROL_MOUNTPOINT}
        with (
            patch.object(reconcile, "_probe_helper_absence", return_value="a" * 64),
            patch.object(reconcile, "docker_capture", return_value=subprocess.CompletedProcess(
                ["docker"], 0, json.dumps([volume]).encode(), b"")),
            patch.object(reconcile, "bounded_capture") as mount,
        ):
            with self.assertRaisesRegex(BuildControlError, "ownership or driver differs"):
                reconcile._absent_helper_evidence(control, "fullmag-control-" + ATTEMPT)
        mount.assert_not_called()

    def test_malformed_control_mountpoint_is_rejected_before_any_helper_mount(self):
        control = SimpleNamespace(volume="selected-control", shared_labels={"owner": "selected"})
        for mountpoint in ("", "relative/path", "/var/lib/docker/../escape", "//server/share"):
            volume = {"Name": "selected-control", "Driver": "local", "Options": None,
                      "Labels": {"owner": "selected"}, "Mountpoint": mountpoint}
            with self.subTest(mountpoint=mountpoint), patch.object(
                reconcile, "_probe_helper_absence", return_value="a" * 64
            ), patch.object(
                reconcile, "docker_capture", return_value=subprocess.CompletedProcess(
                    ["docker"], 0, json.dumps([volume]).encode(), b"")
            ), patch.object(reconcile, "bounded_capture") as mount:
                with self.assertRaises(BuildControlError):
                    reconcile._absent_helper_evidence(control, "fullmag-control-" + ATTEMPT)
                mount.assert_not_called()

    def test_missing_helper_admission_precedes_first_receipt_read(self):
        args = SimpleNamespace(engine_id="engine-test", attempt=ATTEMPT, recover_absent_helper=True)
        with (
            patch.object(reconcile, "docker_capture", return_value=subprocess.CompletedProcess(
                ["docker"], 0, b"engine-test\n", b"")),
            patch.object(reconcile, "_absent_helper_evidence",
                         side_effect=BuildControlError("volume absent")),
            patch.object(reconcile, "read_raw") as read,
        ):
            with self.assertRaisesRegex(BuildControlError, "volume absent"):
                reconcile._observe(SimpleNamespace(), IDENTITY, args)
        read.assert_not_called()


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
            path=lambda value: "/control/" + value,
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

        def commit(*_args, **_kwargs):
            state["committed"] = True
            return subprocess.CompletedProcess(["docker"], 0, b"", b"")

        with (
            patch.object(reconcile, "_identity_and_control", return_value=(Path(IDENTITY["source_root"]), IDENTITY, self.control)),
            patch.object(reconcile, "_observe", return_value=self.observation) as observe,
            patch.object(reconcile, "read_raw", side_effect=read),
            patch.object(reconcile, "_proof_bytes", return_value=b"proof\n"),
            patch.object(reconcile, "_failure_result", return_value=self.result_raw),
            patch.object(reconcile, "_cas_script", return_value="cas"),
            patch.object(reconcile, "bounded_capture", side_effect=commit) as capture,
            patch.object(reconcile, "_probe_helper_absence", return_value="f" * 64),
            patch.object(reconcile.time, "sleep"),
        ):
            result = reconcile.reconcile(self.args)
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertEqual(observe.call_count, 3)
        self.assertEqual(observe.call_args_list[-1].kwargs, {"allowed_archive": None})
        self.assertEqual(capture.call_count, 1)
        payloads = [base64.b64decode(line) for line in capture.call_args.kwargs["data"].splitlines()]
        self.assertEqual(payloads[:3], [self.original_raw, b"proof\n", self.result_raw])
        prepared = json.loads(payloads[3])
        self.assertEqual(prepared, {
            "schema": reconcile.SCHEMA,
            "attempt": ATTEMPT,
            "original_receipt_sha256": reconcile.digest(self.original_raw),
            "compose_sha256": "b" * 64,
            "proof_sha256": reconcile.digest(b"proof\n"),
            "result_sha256": reconcile.digest(self.result_raw),
        })

    def test_changed_second_observation_refuses_before_any_write(self):
        changed = {**self.observation, "engine_id": "different-engine"}
        with (
            patch.object(reconcile, "_identity_and_control", return_value=(Path(IDENTITY["source_root"]), IDENTITY, self.control)),
            patch.object(reconcile, "_observe", side_effect=[self.observation, changed]),
            patch.object(reconcile, "bounded_capture") as write,
            patch.object(reconcile, "bounded_capture") as publish,
            patch.object(reconcile.time, "sleep"),
        ):
            with self.assertRaises(BuildControlError):
                reconcile.reconcile(self.args)
        write.assert_not_called()

    def prepared_fixture(self):
        proof = reconcile._proof_bytes(self.observation, json.loads(self.original_raw))
        result = reconcile._failure_result(self.original_raw, proof, self.observation)
        prepared = reconcile.canonical({
            'schema':reconcile.SCHEMA, 'attempt':ATTEMPT,
            'original_receipt_sha256':self.args.receipt_sha256,
            'compose_sha256':self.args.compose_sha256,
            'proof_sha256':reconcile.digest(proof), 'result_sha256':reconcile.digest(result)})+b'\n'
        root=f'development/attempts/{ATTEMPT}'
        files={root+'/unknown-receipt.json':self.original_raw,
               root+'/reconciliation/prepared.json':prepared,
               root+'/reconciliation/network-failure-proof.json':proof,
               root+'/reconciliation/result.json':result}
        self.args.resume_prepared_sha256=reconcile.digest(prepared)
        self.args.recovery_id='e'*32
        return files

    def test_prepared_recovery_validates_old_generation_without_mutating_it(self):
        files=self.prepared_fixture()
        with patch.object(reconcile,'read_raw', side_effect=lambda c,p,**kw: files.get(p)):
            recovery=reconcile._load_prepared_recovery(self.control,self.args,self.original_raw)
        self.assertEqual(recovery['prepared_sha256'], self.args.resume_prepared_sha256)
        for relative in list(files):
            changed={**files,relative:b'changed'}
            with self.subTest(path=relative), \
                 patch.object(reconcile,'read_raw', side_effect=lambda c,p,**kw: changed.get(p)), \
                 self.assertRaises(BuildControlError):
                reconcile._load_prepared_recovery(self.control,self.args,self.original_raw)
        for suffix in ('network-failure-reconcile.lock','terminal.json'):
            changed={**files,f'development/attempts/{ATTEMPT}/'+suffix:b'partial'}
            with self.subTest(partial=suffix), \
                 patch.object(reconcile,'read_raw',side_effect=lambda c,p,**kw: changed.get(p)), \
                 self.assertRaises(BuildControlError):
                reconcile._load_prepared_recovery(self.control,self.args,self.original_raw)

    def test_prepared_recovery_reobserves_three_times_and_preserves_original_files(self):
        files=self.prepared_fixture()
        root=f'development/attempts/{ATTEMPT}'
        files[root+'/receipt.json']=self.original_raw
        originals=dict(files)
        def read(c,p,**kw): return files.get(p)
        def write(c,p,raw):
            self.assertNotIn(p,files)
            files[p]=raw
        def publish(*a,**kw):
            paths = reconcile._publication_paths(ATTEMPT, self.args.recovery_id)
            payloads = [base64.b64decode(line) for line in kw['data'].splitlines()]
            self.assertEqual(len(payloads), 3)
            for path, payload in zip(paths.values(), payloads):
                self.assertNotIn(path, files)
                files[path] = payload
            result=files[root+'/reconciliation/recoveries/'+self.args.recovery_id+'/result.json']
            for p in (root+'/receipt.json',root+'/terminal.json','development/current.json'): files[p]=result
            return subprocess.CompletedProcess([],0,b'',b'')
        with patch.object(reconcile,'_identity_and_control',return_value=(Path(IDENTITY['source_root']),IDENTITY,self.control)), \
             patch.object(reconcile,'read_raw',side_effect=read), \
             patch.object(reconcile,'_observe',return_value=self.observation) as observe, \
             patch.object(reconcile,'_cas_script',return_value='cas'), \
             patch.object(reconcile,'bounded_capture',side_effect=publish), \
             patch.object(reconcile,'_probe_helper_absence',return_value='f'*64), \
             patch.object(reconcile.time,'sleep'):
            result=reconcile.reconcile(self.args)
        self.assertEqual(result['state'],'failed-confirmed')
        self.assertEqual(observe.call_count,3)
        self.assertTrue(all(call.kwargs=={'allowed_archive':self.original_raw} for call in observe.call_args_list))
        for p,raw in originals.items():
            if p!=root+'/receipt.json': self.assertEqual(files[p],raw)
        published=json.loads(files[root+'/terminal.json'])
        self.assertEqual(published['reconciliation']['previous_prepared_sha256'],self.args.resume_prepared_sha256)

    def test_prepared_recovery_requires_safe_nonce_and_complete_pair(self):
        self.args.resume_prepared_sha256='a'*64
        for nonce in (None,'../escape','A'*32):
            self.args.recovery_id=nonce
            with self.subTest(nonce=nonce), self.assertRaises(BuildControlError):
                reconcile._load_prepared_recovery(self.control,self.args,self.original_raw)




class FailurePublicationShellTests(unittest.TestCase):
    @staticmethod
    def _cas_script_for(base, prepared_documents, *, recover_absent_helper=False):
        control = SimpleNamespace(path=lambda relative: str(base / relative))
        return reconcile._cas_script(
            control, ATTEMPT, *[
                reconcile.digest(value) for value in
                (b"original", b"compose", b"proof", b"result", b"prepared")
            ], recover_absent_helper=recover_absent_helper,
            prepared_documents=prepared_documents,
        )

    def run_publication(self, *, corrupt=False, symlink=False, recover_absent_helper=False,
                        busy_operation_lock=False, missing_operation_lock=False,
                        wrong_active=False, tamper_current_on_terminal=False,
                        live_operation_lock_unheld=False):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            root = base / "development/attempts" / ATTEMPT
            (root / "reconciliation").mkdir(parents=True)
            prepared_documents = {
                str(root / "unknown-receipt.json"): b"original",
                str(root / "reconciliation/network-failure-proof.json"): b"proof",
                str(root / "reconciliation/result.json"): b"result",
                str(root / "reconciliation/prepared.json"): b"prepared",
            }
            (root / "receipt.json").write_bytes(b"original")
            (root / "compose.json").write_bytes(b"compose")

            marker = "b" * 32 + "\n" if wrong_active else ATTEMPT + "\n"
            (base / "active").write_text(marker)
            if corrupt:
                (root / "compose.json").write_bytes(b"changed")
            if symlink:
                (root / "compose.json").rename(root / "real-compose.json")
                (root / "compose.json").symlink_to(root / "real-compose.json")

            operation_lock = base / "operation.lock"
            operation_lock_bytes = b"existing-operation-lock\n"
            if not missing_operation_lock:
                operation_lock.write_bytes(operation_lock_bytes)

            script = self._cas_script_for(
                base, prepared_documents, recover_absent_helper=recover_absent_helper,
            )
            environment = os.environ.copy()
            if tamper_current_on_terminal:
                shim = base / "bin"
                shim.mkdir()
                mv = shim / "mv"
                mv.write_text(
                    """#!/bin/sh
destination=
for argument do destination=$argument; done
/usr/bin/mv "$@" || exit $?
case $destination in */terminal.json) printf tampered > "$FULLMAG_TEST_CURRENT_PATH";; esac
"""
                )
                mv.chmod(0o755)
                environment["PATH"] = str(shim) + os.pathsep + environment["PATH"]
                environment["FULLMAG_TEST_CURRENT_PATH"] = str(base / "development/current.json")

            def execute():
                return subprocess.run(
                    ["bash", "-euc", script],
                    input=reconcile._prepared_input(prepared_documents),
                    capture_output=True,
                    env=environment,
                )

            if missing_operation_lock:
                completed = execute()
            else:
                with operation_lock.open("r+") as lock:
                    if busy_operation_lock or (not recover_absent_helper and not live_operation_lock_unheld):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    completed = execute()

            if missing_operation_lock:
                self.assertFalse(operation_lock.exists())
            else:
                self.assertEqual(operation_lock.read_bytes(), operation_lock_bytes)
            self.assertFalse((base / "development/verified.json").exists())
            failed = (corrupt or symlink or wrong_active or busy_operation_lock
                      or missing_operation_lock or tamper_current_on_terminal
                      or live_operation_lock_unheld)
            if failed:
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual((base / "active").read_text(), marker)
                if tamper_current_on_terminal:
                    self.assertEqual((root / "receipt.json").read_bytes(), b"result")
                    self.assertEqual((base / "development/current.json").read_bytes(), b"tampered")
                    self.assertEqual((root / "terminal.json").read_bytes(), b"result")
                    for relative, value in prepared_documents.items():
                        self.assertEqual(Path(relative).read_bytes(), value)
                else:
                    self.assertEqual((root / "receipt.json").read_bytes(), b"original")
                    self.assertFalse((root / "terminal.json").exists())
                    self.assertFalse((base / "development/current.json").exists())
                    for path in prepared_documents:
                        self.assertFalse(Path(path).exists(), path)
                if busy_operation_lock or missing_operation_lock or live_operation_lock_unheld:
                    self.assertFalse((root / "network-failure-reconcile.lock").exists())
            else:
                self.assertEqual(completed.returncode, 0, completed.stderr.decode())
                for path in (root / "receipt.json", root / "terminal.json",
                             base / "development/current.json"):
                    self.assertEqual(path.read_bytes(), b"result")
                self.assertTrue((root / "unknown-receipt.json").is_file())
                self.assertEqual((root / "unknown-receipt.json").read_bytes(), b"original")
                for relative, value in prepared_documents.items():
                    self.assertEqual(Path(relative).read_bytes(), value)
                if recover_absent_helper:
                    self.assertFalse((base / "active").exists())
                else:
                    self.assertEqual((base / "active").read_text(), ATTEMPT + "\n")

    def test_failure_publication_preserves_owner_and_original(self):
        self.run_publication()

    def test_changed_input_refuses_publication(self):
        self.run_publication(corrupt=True)

    def test_symlink_input_refuses_publication(self):
        self.run_publication(symlink=True)

    def test_live_helper_recovery_requires_the_original_operation_lock(self):
        self.run_publication(live_operation_lock_unheld=True)

    def test_live_helper_recovery_does_not_create_missing_operation_lock_or_journal(self):
        self.run_publication(missing_operation_lock=True)

    def test_absent_and_live_cas_serialize_before_journal_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            root = base / "development/attempts" / ATTEMPT
            (root / "reconciliation").mkdir(parents=True)
            prepared_documents = {
                str(root / "unknown-receipt.json"): b"original",
                str(root / "reconciliation/network-failure-proof.json"): b"proof",
                str(root / "reconciliation/result.json"): b"result",
                str(root / "reconciliation/prepared.json"): b"prepared",
            }
            receipt = root / "receipt.json"
            compose = root / "compose.json"
            active = base / "active"
            operation_lock = base / "operation.lock"
            current = base / "development/current.json"
            verified = base / "development/verified.json"
            terminal = root / "terminal.json"
            reconciliation_lock = root / "network-failure-reconcile.lock"
            marker = ATTEMPT + "\n"
            operation_lock_bytes = b"existing-operation-lock\n"
            receipt.write_bytes(b"original")
            compose.write_bytes(b"compose")
            active.write_text(marker)
            operation_lock.write_bytes(operation_lock_bytes)

            shim = base / "bin"
            shim.mkdir()
            signal_dir = base / "signals"
            signal_dir.mkdir()
            compose_acquired = signal_dir / "compose-acquired"
            absent_ready = signal_dir / "absent-ready"
            release_absent = signal_dir / "release-absent"
            flock = shim / "flock"
            flock.write_text(
                """#!/bin/sh
/usr/bin/flock "$@"
status=$?
if test "$status" -eq 0; then
    case "$*" in
        "-n 6") : > "$FULLMAG_TEST_COMPOSE_ACQUIRED" ;;
        "-n 8")
            test -f "$FULLMAG_TEST_COMPOSE_ACQUIRED" || exit 91
            : > "$FULLMAG_TEST_ABSENT_READY"
            while test ! -e "$FULLMAG_TEST_RELEASE_ABSENT"; do sleep 0.02; done
            ;;
    esac
fi
exit "$status"
"""
            )
            flock.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = str(shim) + os.pathsep + environment["PATH"]
            environment["FULLMAG_TEST_COMPOSE_ACQUIRED"] = str(compose_acquired)
            environment["FULLMAG_TEST_ABSENT_READY"] = str(absent_ready)
            environment["FULLMAG_TEST_RELEASE_ABSENT"] = str(release_absent)

            absent_script = self._cas_script_for(
                base, prepared_documents, recover_absent_helper=True,
            )
            live_script = self._cas_script_for(base, prepared_documents)
            shell = ["bash", "-euc"]
            prepared_input = reconcile._prepared_input(prepared_documents)
            absent = None
            try:
                absent = subprocess.Popen(
                    [*shell, absent_script], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=environment, start_new_session=True,
                )
                assert absent.stdin is not None
                absent.stdin.write(prepared_input)
                absent.stdin.close()
                absent.stdin = None

                deadline = time.monotonic() + 3
                while not absent_ready.exists() and absent.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                if not absent_ready.exists():
                    stdout, stderr = absent.communicate(timeout=2)
                    self.fail(
                        "absent CAS did not acquire both locks before timeout; "
                        f"exit={absent.returncode}, stdout={stdout!r}, stderr={stderr!r}"
                    )
                self.assertTrue(compose_acquired.is_file())

                live = subprocess.run(
                    [*shell, live_script], input=prepared_input,
                    capture_output=True, env=environment, timeout=3,
                )
                self.assertNotEqual(live.returncode, 0, live.stderr.decode("utf-8", "replace"))
                self.assertEqual(active.read_text(), marker)
                self.assertEqual(receipt.read_bytes(), b"original")
                self.assertEqual(compose.read_bytes(), b"compose")
                self.assertEqual(operation_lock.read_bytes(), operation_lock_bytes)
                for path in (*prepared_documents, str(current), str(verified), str(terminal),
                             str(reconciliation_lock)):
                    self.assertFalse(Path(path).exists(), path)

                release_absent.touch()
                stdout, stderr = absent.communicate(timeout=4)
                self.assertEqual(absent.returncode, 0, stderr.decode("utf-8", "replace"))
                for path in (receipt, current, terminal):
                    self.assertEqual(path.read_bytes(), b"result", path)
                archive = root / "unknown-receipt.json"
                self.assertEqual(archive.read_bytes(), b"original")
                for path, expected in prepared_documents.items():
                    self.assertEqual(Path(path).read_bytes(), expected, path)
                self.assertFalse(active.exists())
                self.assertFalse(verified.exists())
                self.assertEqual(operation_lock.read_bytes(), operation_lock_bytes)
            finally:
                if absent is not None and absent.poll() is None:
                    release_absent.touch()
                    try:
                        absent.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(absent.pid, signal.SIGTERM)
                        try:
                            absent.communicate(timeout=2)
                        except subprocess.TimeoutExpired:
                            os.killpg(absent.pid, signal.SIGKILL)
                            absent.wait(timeout=2)
                            for stream in (absent.stdout, absent.stderr):
                                if stream is not None:
                                    stream.close()

    def test_absent_helper_recovery_publishes_before_releasing_marker_and_preserves_archive(self):
        self.run_publication(recover_absent_helper=True)

    def test_absent_helper_recovery_busy_lock_fails_before_any_publication(self):
        self.run_publication(recover_absent_helper=True, busy_operation_lock=True)

    def test_absent_helper_recovery_does_not_create_missing_operation_lock(self):
        self.run_publication(recover_absent_helper=True, missing_operation_lock=True)

    def test_absent_helper_recovery_rejects_wrong_active_marker(self):
        self.run_publication(recover_absent_helper=True, wrong_active=True)

    def test_absent_helper_recovery_rejects_changed_compose(self):
        self.run_publication(recover_absent_helper=True, corrupt=True)

    def test_absent_helper_recovery_rejects_symlink_compose(self):
        self.run_publication(recover_absent_helper=True, symlink=True)

    def test_absent_helper_recovery_keeps_marker_if_publications_differ(self):
        self.run_publication(recover_absent_helper=True, tamper_current_on_terminal=True)


class PreparedGenerationShellTests(unittest.TestCase):
    def run_publication(self, *, corrupt=False, symlink=False, recovery=False, corrupt_previous=False, atomic_prepare=False, history=False, corrupt_history=False, symlink_history=False, late_owner=False):
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
            recovery_args = {}
            if recovery:
                generation = root / 'reconciliation/recoveries' / ('e'*32)
                generation.mkdir(parents=True)
                for name, raw in (('network-failure-proof.json', b'proof'),
                                  ('result.json', b'result'), ('prepared.json', b'prepared')):
                    (generation/name).write_bytes(raw)
                recovery_args['recovery'] = {
                    'recovery_id':'e'*32,
                    'previous_files':{
                        f'development/attempts/{ATTEMPT}/reconciliation/prepared.json':reconcile.digest(b'prepared'),
                        f'development/attempts/{ATTEMPT}/reconciliation/network-failure-proof.json':reconcile.digest(b'proof'),
                        f'development/attempts/{ATTEMPT}/reconciliation/result.json':reconcile.digest(b'result')}}
                if atomic_prepare:
                    docs = {str(generation/name): raw for name, raw in (('network-failure-proof.json', b'proof'), ('result.json', b'result'), ('prepared.json', b'prepared'))}
                    for path in docs: Path(path).unlink()
                    generation.rmdir()
                    recovery_args['prepared_documents'] = docs
                if corrupt_previous:
                    (root/'reconciliation/prepared.json').write_bytes(b'changed')
            if history:
                for name in ("current.json", "verified.json"):
                    (base / "development" / name).write_bytes(b"old-success")
                records = {"development/" + name: reconcile.digest(b"old-success")
                           for name in ("current.json", "verified.json")}
                records["development/absent-owner.json"] = None
                if late_owner:
                    (base / "development/absent-owner.json").write_bytes(b"new-owner")
                recovery_args["retained_records"] = records
                if corrupt_history:
                    (base / "development/current.json").write_bytes(b"changed-history")
                if symlink_history:
                    (base / "development/current.json").unlink()
                    (base / "development/current.json").symlink_to(base / "development/verified.json")
                if atomic_prepare:
                    names = ("unknown-receipt.json", "reconciliation/network-failure-proof.json",
                             "reconciliation/result.json", "reconciliation/prepared.json")
                    recovery_args["prepared_documents"] = {str(root / name): values[name] for name in names}
                    for name in names:
                        (root / name).unlink()
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
                ], **recovery_args)
                completed = subprocess.run(["bash", "-euc", script], input=reconcile._prepared_input(recovery_args.get("prepared_documents")), capture_output=True)
            self.assertEqual((base / "active").read_text(), ATTEMPT + "\n")
            if history:
                self.assertEqual((base / "development/verified.json").read_bytes(), b"old-success")
            else:
                self.assertFalse((base / "development/verified.json").exists())
            if corrupt or symlink or corrupt_previous or corrupt_history or symlink_history or late_owner:
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual((root / "receipt.json").read_bytes(), b"original")
                self.assertFalse((root / "terminal.json").exists())
                if not history:
                    self.assertFalse((base / "development/current.json").exists())
                if history and atomic_prepare:
                    self.assertFalse((root / "reconciliation/prepared.json").exists())
            else:
                self.assertEqual(completed.returncode, 0, completed.stderr.decode())
                if history:
                    self.assertEqual((base / "development/current.json").read_bytes(), b"old-success")
                for path in (root / "receipt.json", root / "terminal.json", *((base / "development/current.json",) if not history else ())):
                    self.assertEqual(path.read_bytes(), b"result")
                self.assertEqual((root / "unknown-receipt.json").read_bytes(), b"original")

    def test_recreated_failure_refuses_new_owner_before_any_preparation(self):
        self.run_publication(history=True, late_owner=True, atomic_prepare=True)

    def test_recreated_failure_preserves_prior_success_and_publishes_only_target(self):
        self.run_publication(history=True, atomic_prepare=True)

    def test_recreated_failure_rejects_changed_prior_pointer_before_preparation(self):
        self.run_publication(history=True, corrupt_history=True, atomic_prepare=True)

    def test_recreated_failure_rejects_symlink_prior_pointer(self):
        self.run_publication(history=True, symlink_history=True, atomic_prepare=True)

    def test_failure_publication_preserves_owner_and_original(self):
        self.run_publication()

    def test_changed_input_refuses_publication(self):
        self.run_publication(corrupt=True)

    def test_symlink_input_refuses_publication(self):
        self.run_publication(symlink=True)

    def test_prepared_generation_atomically_prepares_new_generation(self):
        self.run_publication(recovery=True, atomic_prepare=True)

    def test_prepared_generation_refuses_tamper_before_preparation(self):
        self.run_publication(recovery=True, corrupt_previous=True, atomic_prepare=True)

    def test_prepared_generation_cas_preserves_old_files(self):
        self.run_publication(recovery=True)

    def test_prepared_generation_cas_rejects_old_preparation_changed_after_observation(self):
        self.run_publication(recovery=True, corrupt_previous=True)



if __name__ == "__main__":
    unittest.main()
