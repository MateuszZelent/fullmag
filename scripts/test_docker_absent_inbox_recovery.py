"""V7 absent-inbox proof boundary regressions."""
import ast
import copy
import hashlib
import inspect
import os
from unittest.mock import patch
from test_docker_container_runtime_recovery import runtime_service
import docker_prepare_container_recovery as preparation
from test_docker_prepare_container_recovery import Control
import test_docker_volume_abrupt_stop_recovery as abrupt_tests
from pathlib import Path
import tempfile
import unittest
import docker_volume_container_recovery as r
from test_docker_pending_inbox_recovery import request_fixture


def fixture():
    req = request_fixture()
    req["schema_version"] = r.ABSENT_INBOX_REQUEST_SCHEMA
    req["retained_terminal_runs"].append({**req["retained_terminal_runs"][0], "run_id": "run-absent"})
    req["retained_absent_inboxes"] = [{"run_id": "run-absent", "task_id": "task-b", "attempt_id": "attempt-b", "resource_id": "cpu", "ownership_epoch": 1, "inbox_absence": "directory_absent", "release_proof_sha256": "e"*64}]
    return req


class AbsentInboxTests(unittest.TestCase):
    def test_valid_and_old_versions(self):
        req = fixture()
        self.assertEqual(r.expected_recovery_outcome(req), "retained_absent_inboxes_recovered")
        self.assertEqual(runtime_service._container_recovery_expected_outcome(req), "retained_absent_inboxes_recovered")
        for version in range(1,7):
            for pins in (None, req["retained_absent_inboxes"]):
                with self.subTest(version=version), self.assertRaises(r.ContainerRecoveryError):
                    r.expected_recovery_outcome({**req, "schema_version": "runtime_service_container_recovery_request.v"+str(version), "retained_absent_inboxes": pins})

    def test_invalid_pins_and_overlap(self):
        req = fixture(); pin = req["retained_absent_inboxes"][0]
        bad = [None, [], [pin]*129, [pin,pin]]
        for changes in ({"run_id": []}, {"run_id": {}}, {"run_id": "run-a"}, {"run_id": "unknown"}, {"ownership_epoch": True}, {"release_proof_sha256": "0"*64}, {"inbox_absence": "empty_directory"}, {"inbox_sha256": "a"*64}):
            bad.append([{**pin, **changes}])
        bad.append([pin, {**pin, "ownership_epoch":2}])
        bad.append([pin, {**pin, "attempt_id":"other"}])
        for pins in bad:
            with self.subTest(pins=pins), self.assertRaises(r.ContainerRecoveryError):
                r.expected_recovery_outcome({**req,"retained_absent_inboxes":pins})
        for pins in bad:
            with self.subTest(bridge=pins), self.assertRaises(runtime_service.RuntimeServiceError):
                runtime_service._container_recovery_expected_outcome({**req,"retained_absent_inboxes":pins})
        del req["retained_pending_inboxes"]
        with self.assertRaises(r.ContainerRecoveryError): r.expected_recovery_outcome(req)

    def test_snapshot_absence_and_raw_proof(self):
        tree=ast.parse(inspect.getsource(r._ledger_and_store_snapshot))
        script=next(n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str) and "absent_pins=observation" in n.value)
        block=script[script.index("absent_pins=observation"):script.index("print(json.dumps({'schema':'fullmag.container-recovery-storage-proof.v1'")]
        with tempfile.TemporaryDirectory() as tmp:
            store=Path(tmp)/"store"; ledger=Path(tmp)/"ledger"
            inbox=store/"runs/run-absent/worker_inbox"; inbox.parent.mkdir(parents=True)
            (ledger/"proofs").mkdir(parents=True)
            raw=b'{"proof":"raw bytes"}'
            digest=hashlib.sha256(raw).hexdigest(); proof=ledger/"proofs"/(digest+".json"); proof.write_bytes(raw)
            pin={**fixture()["retained_absent_inboxes"][0],"release_proof_sha256":digest}
            ns={"observation":{"retained_absent_inboxes":[pin]},"pending_pins":[{}],"store":store,"ledger":ledger,"os":os,"hashlib":hashlib,"regular":lambda p,n:p.read_bytes()}
            exec(block,ns)
            inbox.mkdir()
            with self.assertRaises(SystemExit): exec(block,ns)
            inbox.rmdir(); inbox.symlink_to(inbox.parent/"missing")
            with self.assertRaises(SystemExit): exec(block,ns)
            inbox.unlink(); proof.write_bytes(raw+b" ")
            with self.assertRaises(RuntimeError): exec(block,ns)

    def test_prepare_keeps_absent_pins_in_both_snapshots(self):
        req=fixture(); control=Control()
        pins={"request_id":"a80357af-97c4-436e-8773-841bd20e5b72","source_root":"/registered/source","development_attempt":"b"*32}
        with patch.object(r,"prepare_abrupt_stop_proof",return_value={"schema":"fixture"}) as builder, patch.object(r,"validate_operator_authorization",side_effect=lambda v:v), patch.object(r,"validate_abrupt_stop_proof"):
            preparation.prepare(control,pins,{},**{k:v for k,v in req.items() if k!="schema_version"},publish=True)
            self.assertEqual(builder.call_count,2)
            for call in builder.call_args_list: self.assertEqual(call.kwargs["retained_absent_inboxes"],req["retained_absent_inboxes"])

    def test_request_abrupt_version_binding(self):
        req=fixture()
        proof={"schema":r.ABRUPT_PROOF_ABSENT_INBOX_SCHEMA,**{k:v for k,v in req.items() if k!="schema_version"}}
        r._assert_request_matches_abrupt_retained_pins(req,proof)
        with self.assertRaises(r.ContainerRecoveryError): r._assert_request_matches_abrupt_retained_pins(req,{**proof,"schema":r.ABRUPT_PROOF_PENDING_INBOX_SCHEMA})
        with self.assertRaises(r.ContainerRecoveryError): r._assert_request_matches_abrupt_retained_pins(req,{**proof,"retained_absent_inboxes":[]})
