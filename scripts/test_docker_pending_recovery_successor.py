"""Explicit successor routing must preserve old authority and pin every handoff."""
from copy import deepcopy
import hashlib
import json
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_volume_dev as dev
import docker_volume_container_recovery as recovery
import docker_volume_pending_recovery_successor as successor
from docker_build_control import BuildControlError
import test_docker_volume_pre_admission_integration as integration


class SuccessorBindingTests(unittest.TestCase):
    def setUp(self):
        self.document={"name":"fullmag-test"}; self.previous={"attempt":"a"*32}
        self.binding={"schema":successor.SCHEMA,"development_attempt":"a"*32,
            "compose_config_sha256":hashlib.sha256(recovery._canonical(self.document)).hexdigest(),
            **{key:{"path":"verification/"+key+".json","sha256":"b"*64}
               for key in ("candidate","preview","stop_witness","authorization")}}
        self.raw=recovery._canonical(self.binding); self.sha=hashlib.sha256(self.raw).hexdigest()
        self.context={"recovery_environment":{
            recovery.AUTHORIZATION_ENV:"/opt/fullmag/control/verification/new.json",
            recovery.AUTHORIZATION_SHA_ENV:"c"*64},
            "recovery_metadata":{"schema":"fullmag.container-recovery.v1","request_id":"12345678-1234-1234-8234-123456789abc",
                **{key:"d"*64 for key in ("request_sha256","attestation_sha256","manifest_sha256","authorization_sha256","stop_journal_sha256")},
                "removed_container_ids":["e"*64,"f"*64]}}
        self.producer=SimpleNamespace(validate_published=mock.Mock(return_value=self.context))
        self.stack=mock.patch.dict(sys.modules,{"docker_prepare_pending_recovery_successor":self.producer}); self.stack.start(); self.addCleanup(self.stack.stop)

    def run_context(self, raw=None, **kwargs):
        with mock.patch.object(recovery,"_control_bytes",return_value=self.raw if raw is None else raw):
            return successor.retained_context(object(),self.previous,self.document,{"backend":{}},"verification/successor.json",self.sha,**kwargs)

    def test_explicit_binding_yields_typed_new_authority(self):
        original=deepcopy(self.document)
        context=self.run_context()
        self.assertIsInstance(context,dev.RetainedContainerRecoveryContext)
        self.assertEqual(dict(context),self.context)
        self.assertEqual(context.witness,{"proof_path":"verification/successor.json","proof_sha256":self.sha})
        self.assertEqual(self.document,original)
        self.producer.validate_published.assert_called_once()

    def test_changed_bytes_or_wrong_attempt_stop_before_producer(self):
        with self.assertRaises(BuildControlError): self.run_context(raw=self.raw+b" ")
        self.previous["attempt"]="9"*32
        with self.assertRaises(BuildControlError): self.run_context()
        self.producer.validate_published.assert_not_called()

    def test_pair_and_path_are_strict(self):
        for path,sha in (("verification/x",None),(None,"a"*64),("../x","a"*64),("/x","a"*64)):
            with self.subTest(path=path),self.assertRaises(BuildControlError): successor.option_pins(path,sha)

    def test_producer_refusal_and_removed_proof_are_not_bypassed(self):
        self.producer.validate_published.side_effect=BuildControlError("native preview changed")
        with self.assertRaisesRegex(BuildControlError,"native preview changed"): self.run_context()
        self.producer.validate_published.side_effect=None
        proof={"schema":"removed-proof"}
        self.run_context(removed_container_proof=proof)
        self.assertEqual(self.producer.validate_published.call_args.kwargs["removed_container_proof"],proof)


class SuccessorRoutingTests(unittest.TestCase):
    def setUp(self):
        self.harness=integration._Harness(); self.addCleanup(self.harness.close)
        self.harness.args.pending_recovery_successor="verification/successor.json"
        self.harness.args.pending_recovery_successor_sha256="a"*64
        self.runner=integration.RetainedPreAdmissionIntegrationTests()
        self.context=successor.PendingRecoverySuccessorContext({"recovery_environment":{},"recovery_metadata":{}},
            {"proof_path":"verification/successor.json","proof_sha256":"a"*64})

    def run_recreation(self, context):
        helper=integration._helper_module(self.harness,reject=True)
        with mock.patch.object(dev,"_validate_recreation_resume_records",return_value={
                "native_recovery_context":dict(self.context),
                "proof":{"pending_recovery_successor":self.context.witness}}) as completed:
            result=self.runner._run(self.harness,helper=helper,recovery_context=context)
            self.completed=completed
            return result

    def test_new_authority_revalidated_before_removal_and_passed_to_start(self):
        calls=[]
        def observed(*args,**kwargs):
            calls.append(kwargs); return self.context
        result,started=self.run_recreation(observed)
        self.assertEqual(result,{"started":True})
        self.assertGreaterEqual(len(calls),3)
        self.assertTrue(all(call.get("pending_successor")==("verification/successor.json","a"*64) for call in calls))
        self.assertEqual(started.call_args.kwargs["recovery_environment"],{})
        self.assertEqual(self.harness.events.count("rm"),1)
        self.completed.assert_called_once()
        self.assertEqual(started.call_args.args[0].resume_recreation,
                         self.completed.call_args.args[0].resume_recreation)
        self.assertEqual(started.call_args.kwargs["recreation_resume_proof"],
                         {"pending_recovery_successor":self.context.witness})

    def test_binding_change_under_lease_refuses_removal(self):
        changed=successor.PendingRecoverySuccessorContext(dict(self.context),{"proof_path":"verification/successor.json","proof_sha256":"b"*64})
        contexts=iter([self.context,changed])
        with self.assertRaisesRegex(BuildControlError,"proof changed under recreate lease"):
            self.run_recreation(lambda *args,**kwargs:next(contexts))
        self.assertNotIn("rm",self.harness.events)

    def test_authority_change_at_final_boundary_refuses_removal(self):
        changed=successor.PendingRecoverySuccessorContext({"recovery_environment":{"changed":True},"recovery_metadata":{}},self.context.witness)
        contexts=iter([self.context,self.context,changed])
        with self.assertRaisesRegex(BuildControlError,"authority changed before removal"):
            self.run_recreation(lambda *args,**kwargs:next(contexts))
        self.assertNotIn("rm",self.harness.events)


if __name__=="__main__": unittest.main()
