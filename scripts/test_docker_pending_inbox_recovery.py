"""Versioned pending-inbox pins, publication propagation and raw evidence checks."""
import ast
import copy
import hashlib
import inspect
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import docker_volume_container_recovery as r
import docker_prepare_container_recovery as preparation
import docker_volume_dev as dev
from test_docker_prepare_container_recovery import Control
import test_docker_volume_abrupt_stop_recovery as abrupt_tests
import test_docker_volume_recovery_build as build_tests


def request_fixture():
    return {
        "schema_version": r.PENDING_INBOX_REQUEST_SCHEMA,
        "retained_terminal_runs": [{"run_id": "run-a", "run_intent_sha256": "a"*64,
            "run_catalog_sha256": "b"*64, "artifact_catalog_sha256": None}],
        "retained_held_manual_runs": [{"run_id": "run-held", "run_intent_sha256": "a"*64,
            "run_catalog_sha256": "b"*64, "start_release": "absent"}],
        "retained_attempt_histories": [{"run_id": "run-a", "run_evidence_sha256": "c"*64,
            "attempts": [{"task_id": "task-a", "attempt_id": "old-attempt", "ownership_epoch": 1, "resource_id": "cpu"}]}],
        "retained_pending_inboxes": [{"run_id": "run-a", "task_id": "task-a", "attempt_id": "attempt-a",
            "resource_id": "cpu", "ownership_epoch": 2, "inbox_sha256": "d"*64, "kind": "failed_final_heartbeat"}],
    }


class PendingInboxTests(unittest.TestCase):
    def test_both_kinds_have_distinct_v6_outcome(self):
        request = request_fixture()
        self.assertEqual(r.expected_recovery_outcome(request), "retained_pending_inboxes_recovered")
        request["retained_pending_inboxes"][0].update(kind="cancelled_before_spawn", release_proof_sha256="e"*64)
        self.assertEqual(r.expected_recovery_outcome(request), "retained_pending_inboxes_recovered")

    def test_old_versions_refuse_pending_field_even_null(self):
        for version in range(1,6):
            for pins in (None, request_fixture()["retained_pending_inboxes"]):
                with self.subTest(version=version, pins=pins), self.assertRaises(r.ContainerRecoveryError):
                    r.expected_recovery_outcome({**request_fixture(), "schema_version": "runtime_service_container_recovery_request.v"+str(version), "retained_pending_inboxes": pins})

    def test_bad_pins_and_missing_v5_arrays_refuse(self):
        request = request_fixture(); pin = request["retained_pending_inboxes"][0]
        bad = [None, [], [pin,pin], [pin]*129]
        for changes in ({"ownership_epoch":True}, {"ownership_epoch":2**64}, {"inbox_sha256":"0"*64},
                {"release_proof_sha256":None}, {"kind":"cancelled_before_spawn"}, {"run_id":"other"},
                {"task_id":"CON"}, {"resource_id":"../x"}, {"kind":"start"}):
            bad.append([{**pin, **changes}])
        bad.append([pin, {**pin, "attempt_id":"different", "resource_id":"other"}])
        for pins in bad:
            with self.subTest(pins=pins), self.assertRaises(r.ContainerRecoveryError):
                r.expected_recovery_outcome({**request, "retained_pending_inboxes":pins})
        for key in ("retained_terminal_runs","retained_held_manual_runs","retained_attempt_histories"):
            with self.subTest(missing=key), self.assertRaises(r.ContainerRecoveryError):
                r.expected_recovery_outcome({k:v for k,v in request.items() if k!=key})

    def test_abrupt_v4_binds_pending_and_storage_evidence(self):
        proof, _, _ = abrupt_tests.AbruptStopTests().fixture(); request = request_fixture()
        proof.update(schema=r.ABRUPT_PROOF_PENDING_INBOX_SCHEMA,
                     **{k:v for k,v in request.items() if k!="schema_version"})
        proof["storage_proof"].update(run_records=sorted(request["retained_terminal_runs"]+request["retained_held_manual_runs"],key=lambda p:p["run_id"]),
            retained_attempt_histories=request["retained_attempt_histories"], retained_pending_inboxes=request["retained_pending_inboxes"])
        auth = r.validate_operator_authorization({**proof["authorization_pins"],"schema_version":r.ABRUPT_OPERATOR_SCHEMA,
            "abrupt_stop_proof":"verification/proof.json","abrupt_stop_proof_sha256":r._sha256(r._canonical(proof))})
        r.validate_abrupt_stop_proof(proof,auth)
        r._assert_request_matches_abrupt_retained_pins(request,proof)
        for mutate in (lambda p:p.update(schema=r.ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA),
                       lambda p:p["storage_proof"].update(retained_pending_inboxes=[])):
            bad=copy.deepcopy(proof); mutate(bad)
            with self.assertRaises(r.ContainerRecoveryError): r.validate_abrupt_stop_proof(bad,auth)
        with self.assertRaises(r.ContainerRecoveryError):
            r._assert_request_matches_abrupt_retained_pins({**request,"retained_pending_inboxes":[]},proof)

    def test_prepare_propagates_pins_twice_and_drift_does_not_publish(self):
        request=request_fixture(); control=Control()
        pins={"request_id":"a80357af-97c4-436e-8773-841bd20e5b72","source_root":"/registered/source","development_attempt":"b"*32}
        options={k:v for k,v in request.items() if k!="schema_version"}
        with patch.object(r,"prepare_abrupt_stop_proof",return_value={"schema":"fixture"}) as builder, \
             patch.object(r,"validate_operator_authorization",side_effect=lambda v:v), \
             patch.object(r,"validate_abrupt_stop_proof"):
            result=preparation.prepare(control,pins,{},**options,publish=True)
            self.assertFalse(result["compute_started"])
            self.assertEqual(builder.call_count,2)
            for call in builder.call_args_list: self.assertEqual(call.kwargs["retained_pending_inboxes"],request["retained_pending_inboxes"])
            control=Control(); builder.side_effect=[{"pins":1},{"pins":2}]
            with self.assertRaisesRegex(preparation.BuildControlError,"changed before publication"):
                preparation.prepare(control,pins,{},**options,publish=True)
            self.assertFalse(control.records)
        with self.assertRaises(preparation.BuildControlError):
            preparation.prepare(control,pins,{},retained_pending_inboxes=[])

    def test_cli_reads_pending_file_and_requires_explicit_history(self):
        request=request_fixture()
        class StopBeforeStorage(Exception):
            pass
        values={"history.json":request["retained_attempt_histories"],"pending.json":request["retained_pending_inboxes"]}
        class Host:
            def read_owned_regular(self,path,maximum):
                return json.dumps(values[path.name]).encode()
        args=["--repo-root","/","--source-root","/","--operator-pins","/operator.json",
              "--retained-terminal-runs","/terminal.json","--retained-held-manual-runs","/held.json",
              "--retained-attempt-histories","/history.json","--retained-pending-inboxes","/pending.json"]
        with patch.object(preparation,"_read_retained_run_inputs",return_value=(request["retained_terminal_runs"],request["retained_held_manual_runs"])), \
             patch.object(dev,"_session_host",return_value=Host()), \
             patch.object(preparation,"select_checkout",side_effect=StopBeforeStorage) as selected:
            with self.assertRaises(StopBeforeStorage): preparation.main(args)
            self.assertEqual(selected.call_count,1)
            for value in ({},None):
                values["pending.json"]=value
                with self.assertRaisesRegex(preparation.BuildControlError,"must be an array"):
                    preparation.main(args)
            values["pending.json"]=request["retained_pending_inboxes"]
            args.remove("--retained-attempt-histories"); args.remove("/history.json")
            with self.assertRaisesRegex(preparation.BuildControlError,"requires --retained-attempt-histories"):
                preparation.main(args)

    def test_build_request_v3_requires_exact_pending_pins(self):
        proof,_,_=abrupt_tests.AbruptStopTests().fixture(); request=request_fixture()
        value={"schema":dev._RECOVERY_PENDING_BUILD_SCHEMA,"authorization_pins":proof["authorization_pins"],
            **{k:v for k,v in request.items() if k!="schema_version"},"source_commit":"a"*40,
            "baked_helpers":{name:"b"*64 for name in dev._RECOVERY_BUILD_HELPERS},
            **{key:"c"*64 for key in ("storage_proof_sha256","certificate_sha256","source_digest","source_snapshot_sha256","controller_sha256")}}
        self.assertEqual(dev._recovery_build_request(json.dumps(value)),value)
        for schema in (dev._RECOVERY_BUILD_SCHEMA,dev._RECOVERY_HISTORY_BUILD_SCHEMA):
            with self.assertRaises(dev.BuildControlError): dev._recovery_build_request(json.dumps({**value,"schema":schema}))
        with self.assertRaises(dev.BuildControlError):
            dev._recovery_build_request(json.dumps({k:v for k,v in value.items() if k!="retained_pending_inboxes"}))

    def test_pending_build_requires_native_v6_capability(self):
        value=build_tests.request(); value["schema"]=dev._RECOVERY_PENDING_BUILD_SCHEMA
        receipt,provenance,capability=build_tests.publication(value)
        for schemas in ([r.HELD_MANUAL_REQUEST_SCHEMA], [r.HELD_MANUAL_REQUEST_SCHEMA,r.ATTEMPT_HISTORY_REQUEST_SCHEMA]):
            capability["capabilities"]["supported_recovery_schemas"]=schemas
            capability["raw_utf8"]=json.dumps(capability["capabilities"])
            with self.assertRaisesRegex(dev.BuildControlError,"v6 recovery capability"):
                dev._recovery_build_publication(receipt,provenance,capability,value)
        capability["capabilities"]["supported_recovery_schemas"].append(r.PENDING_INBOX_REQUEST_SCHEMA)
        capability["raw_utf8"]=json.dumps(capability["capabilities"])
        dev._recovery_build_publication(receipt,provenance,capability,value)

    def snapshot_block(self):
        tree=ast.parse(inspect.getsource(r._ledger_and_store_snapshot))
        scripts=[node.value for node in ast.walk(tree) if isinstance(node,ast.Constant) and isinstance(node.value,str) and "# This binds the discovery pins" in node.value]
        self.assertEqual(len(scripts),1)
        return "pending_pins=" + scripts[0].split("# This binds the discovery pins",1)[1].split("print(json.dumps",1)[0].split("pending_pins=",1)[1]

    def test_snapshot_pins_raw_bytes_and_unique_claim_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); runs=root/"runs"; ledger=root/"ledger"
            inbox=runs/"run-a"/"worker_inbox"; inbox.mkdir(parents=True)
            (ledger/"proofs").mkdir(parents=True)
            request=request_fixture(); pin=request["retained_pending_inboxes"][0]
            raw=json.dumps({"payload":{"claim":{k:pin[k] for k in ("run_id","task_id","attempt_id","ownership_epoch")}}},indent=2).encode()
            path=inbox/"entry.json"; path.write_bytes(raw); pin["inbox_sha256"]=hashlib.sha256(raw).hexdigest()
            proof=b'{"kind":"worker_no_spawn"}'
            proof_sha=hashlib.sha256(proof).hexdigest(); proof_path=ledger/"proofs"/(proof_sha+".json"); proof_path.write_bytes(proof)
            namespace={"observation":{"retained_pending_inboxes":[pin]},"v5":True,"runs":runs,"ledger":ledger,
                "hashlib":hashlib,"json":json,"regular":lambda p,label:p.read_bytes()}
            code=self.snapshot_block(); exec(code,namespace)
            pin.update(kind="cancelled_before_spawn",release_proof_sha256=proof_sha); exec(code,namespace)
            self.assertEqual(path.read_bytes(),raw); self.assertEqual(proof_path.read_bytes(),proof)
            for target,changed in ((path,raw+b" "),(proof_path,proof+b" ")):
                original=target.read_bytes(); target.write_bytes(changed)
                with self.assertRaises(RuntimeError): exec(code,namespace)
                target.write_bytes(original)
            duplicate=inbox/"duplicate.json"; duplicate.write_bytes(raw)
            with self.assertRaisesRegex(RuntimeError,"identity differ"): exec(code,namespace)
            duplicate.unlink()
            changed=json.loads(raw); changed["payload"]["claim"]["attempt_id"]="foreign"; path.write_text(json.dumps(changed))
            with self.assertRaises(RuntimeError): exec(code,namespace)


if __name__ == "__main__":
    unittest.main()
