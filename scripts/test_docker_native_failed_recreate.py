"""Focused source regressions for native failed-stop recreation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from subprocess import CompletedProcess
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev as dev
import docker_volume_activation_reconcile as reconcile
import docker_volume_stop_failed as stop_failed
import docker_volume_stop_unadmitted as stop_unadmitted


BACKEND_ID = "b" * 64
IMAGE_ID = "sha256:" + "a" * 64


def failed_owner(*, compute_status: str = "exited_success") -> dict[str, object]:
    return {
        "schema_version": "runtime_service_owner.v1",
        "protocol": "stdin-v1",
        "state": "failed",
        "owner_token": "owner-token",
        "process_start_token": "process-token",
        "pid": 3241,
        "host": "fullmag-test-host",
        "target_id": "docker-all",
        "control_address": "127.0.0.1:43123",
        "acquired_at": "2026-10-19T10:00:00Z",
        "heartbeat_at": "2026-10-19T10:00:01Z",
        "build_commit": "a" * 40,
        "build_snapshot": "b" * 64,
        "compute_pool_id": "compute-pool",
        "preparation_pool_id": "preparation-pool",
        "compute_pool_generation": 7,
        "preparation_pool_generation": 8,
        "children": [
            {"role": "compute", "pid": 3250, "status": compute_status},
            {"role": "preparation", "pid": 3251, "status": "exited_success"},
        ],
    }


def ready_owner() -> dict[str, object]:
    value = failed_owner()
    value["state"] = "ready"
    value["children"] = [
        {**child, "status": "running"} for child in value["children"]
    ]
    return value


def native_probe() -> dict[str, object]:
    owner = failed_owner()
    owner_raw = json.dumps(owner, sort_keys=True).encode()
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime CLI failed: native service exited during startup",
    }
    return {
        "schema": stop_failed.NATIVE_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "d" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "failed_owner": owner,
        "api_pid_exists": False,
        "native_processes_live": False,
        "startup_enabled": None,
        "legacy_activation_marker_exists": False,
        "reservation_states": ["released"],
        "lease_states": ["released"],
        "active_lease_count": 0,
    }


def after_ready_native_probe() -> dict[str, object]:
    ready = ready_owner()
    owner = failed_owner(compute_status="exited_failure")
    owner_raw = json.dumps(owner, sort_keys=True).encode()
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime service owner observation failed during supervision",
        "service_owner": ready,
    }
    return {
        "schema": stop_failed.NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "d" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "failed_owner": owner,
        "api_pid_exists": False,
        "owner_pid_exists": False,
        "child_pids_exist": False,
        "native_processes_live": False,
        "startup_enabled": None,
        "legacy_activation_marker_exists": False,
        "reservation_states": ["released"],
        "lease_states": ["released"],
        "active_lease_count": 0,
    }


def terminal_receipt() -> dict[str, object]:
    return {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "shutdown_unknown",
        "api_exit_code": -15,
        "runtime_pid": None,
    }


class NativeFailedRecreateTests(unittest.TestCase):
    def setUp(self):
        self.control = Mock()
        self.control.project = "fullmag-worktree-test"
        self.control.volume = "fullmag-worktree-test-control"
        self.control.identity = {
            "project_name": self.control.project,
            "project_id": "fullmag-project",
            "worktree_id": "test",
            "checkout_kind": "worktree",
        }
        self.control.read.side_effect = self.read_control
        self.namespace_raw = None
        self.terminal = terminal_receipt()
        self.owner = failed_owner()
        self.terminal_raw = json.dumps(self.terminal, sort_keys=True).encode()
        self.owner_raw = json.dumps(self.owner, sort_keys=True).encode()
        self.journal = {
            "schema": "fullmag.stop-failed-admission.v1",
            "state": "stopped-confirmed",
            "failure_kind": "native-start-failure",
            "container_id": BACKEND_ID,
            "image_id": IMAGE_ID,
            "exit_code": 1,
            "failure_receipt": {
                "sha256": "d" * 64,
                "receipt": native_probe()["process_receipt"],
            },
            "native_failure_probe": native_probe(),
            "terminal_process_receipt": self.terminal,
            "terminal_failed_owner": self.owner,
            "terminal_failed_owner_sha256": hashlib.sha256(self.owner_raw).hexdigest(),
            "container_state": self.container_state(),
        }
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        self.inspect_patch = patch.object(
            reconcile, "docker_capture", return_value=self.stopped_backend_inspect()
        )
        self.inspect_patch.start()
        self.addCleanup(self.inspect_patch.stop)

    @staticmethod
    def container_state() -> dict[str, object]:
        return {
            "id": BACKEND_ID,
            "image": IMAGE_ID,
            "started_at": "2026-10-19T10:00:00.000000000Z",
            "finished_at": "2026-10-19T10:00:10.000000000Z",
            "exit_code": 1,
        }

    def stopped_backend_inspect(self) -> CompletedProcess:
        state = self.container_state()
        document = {
            "Id": BACKEND_ID,
            "Image": IMAGE_ID,
            "State": {
                "Running": False,
                "Status": "exited",
                "StartedAt": state["started_at"],
                "FinishedAt": state["finished_at"],
                "ExitCode": state["exit_code"],
            },
            "Config": {
                "Labels": {
                    "com.docker.compose.project": self.control.project,
                    "com.docker.compose.service": "backend",
                    "org.fullmag.source.project-id": "fullmag-project",
                    "org.fullmag.source.worktree-id": "test",
                    "org.fullmag.source.checkout-kind": "worktree",
                    "org.fullmag.compose.project": self.control.project,
                }
            },
        }
        return CompletedProcess(
            ["docker", "inspect"], 0,
            json.dumps([document]).encode(), b"",
        )

    def read_control(self, relative, *, optional=False):
        if relative == "verification/stop-failed-" + BACKEND_ID + ".json":
            return self.journal
        raise AssertionError(relative)

    def control_bytes(self, _control, relative, *, optional=False):
        if relative == "verification/stop-failed-" + BACKEND_ID + ".json":
            return self.journal_raw
        if relative == "verification/stopped-namespace-attestation-" + BACKEND_ID + ".json":
            return self.namespace_raw
        if relative.endswith("process-tree.json"):
            return self.terminal_raw
        if relative.endswith("OWNER.json"):
            return self.owner_raw
        raise AssertionError(relative)

    def previous(self):
        return {"inputs": {"image_id": IMAGE_ID, "source_root": "C:/git/fullmag"}}

    def configure_after_ready_journal(self):
        probe = after_ready_native_probe()
        ready = probe["process_receipt"]["service_owner"]
        self.terminal = {**terminal_receipt(), "service_owner": ready}
        self.owner = probe["failed_owner"]
        self.terminal_raw = json.dumps(self.terminal, sort_keys=True).encode()
        self.owner_raw = json.dumps(self.owner, sort_keys=True).encode()
        self.journal = {
            "schema": "fullmag.stop-failed-admission.v1",
            "state": "stopped-confirmed",
            "failure_kind": "native-after-ready-failure",
            "container_id": BACKEND_ID,
            "image_id": IMAGE_ID,
            "exit_code": 1,
            "failure_receipt": {
                "sha256": "d" * 64,
                "receipt": probe["process_receipt"],
            },
            "native_failure_probe": probe,
            "retained_ready_owner": ready,
            "terminal_process_receipt": self.terminal,
            "terminal_retained_ready_owner": ready,
            "terminal_failed_owner": self.owner,
            "terminal_failed_owner_sha256": hashlib.sha256(self.owner_raw).hexdigest(),
            "container_state": self.container_state(),
        }
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()

    def make_namespace_attestation(self) -> None:
        probe = self.journal["native_failure_probe"]
        attestation = {
            "schema": reconcile.NAMESPACE_ATTESTATION_SCHEMA,
            "state": "stopped-confirmed",
            "compose_project": self.control.project,
            "control_volume": self.control.volume,
            "backend_container": BACKEND_ID,
            "image_id": IMAGE_ID,
            "source_root": "C:/git/fullmag",
            "container_state": self.container_state(),
            "stop_journal_path": "verification/stop-failed-" + BACKEND_ID + ".json",
            "stop_journal_sha256": hashlib.sha256(self.journal_raw).hexdigest(),
            "terminal_process_receipt_path": "runtime-control/runtime-service/process-tree.json",
            "terminal_process_receipt_sha256": hashlib.sha256(self.terminal_raw).hexdigest(),
            "terminal_process_receipt": self.terminal,
            "terminal_failed_owner_path": "runtime-control/runtime-services/OWNER.json",
            "terminal_failed_owner_sha256": hashlib.sha256(self.owner_raw).hexdigest(),
            "terminal_failed_owner": self.owner,
            "failure_kind": self.journal["failure_kind"],
            "native_failure_probe_sha256": hashlib.sha256(
                reconcile.canonical(probe) + b"\n"
            ).hexdigest(),
            "native_failure_probe": probe,
            "created_at": 1_729_000_000.0,
        }
        if self.journal["failure_kind"] == "native-after-ready-failure":
            attestation["retained_ready_owner"] = self.journal["retained_ready_owner"]
        self.namespace_raw = reconcile.canonical(attestation) + b"\n"

    def test_native_stop_journal_pins_owner_and_current_config(self):
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        self.assertEqual(context["previous_config_sha256"], "c" * 64)
        self.assertNotIn("recovery_metadata", context)
        self.assertNotIn("recovery_environment", context)
        self.assertFalse(context["native_restart_metadata"]["claim_pending"])
        self.assertEqual(
            context["native_restart_metadata"]["terminal_failed_owner_sha256"],
            hashlib.sha256(self.owner_raw).hexdigest(),
        )

    def test_native_stop_refuses_changed_failed_owner(self):
        altered = dict(self.owner)
        altered["heartbeat_at"] = "2026-10-19T10:00:02Z"
        self.owner_raw = json.dumps(altered, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "failed owner changed"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )

    def test_native_stop_refuses_changed_runtime_configuration(self):
        self.journal["previous_config_sha256"] = "d" * 64
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "configuration digest differs"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )

    def test_legacy_stop_journal_requires_fresh_namespace_attestation(self):
        self.journal.pop("container_state")
        self.journal.pop("terminal_failed_owner_sha256")
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "fresh namespace attestation"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )

    def test_inline_stop_journal_uses_probe_owner_digest(self):
        self.journal.pop("terminal_failed_owner_sha256")
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        self.assertEqual(
            context["native_restart_metadata"]["terminal_failed_owner_sha256"],
            hashlib.sha256(self.owner_raw).hexdigest(),
        )

    def test_legacy_stop_journal_accepts_matching_fresh_namespace_attestation(self):
        self.journal.pop("container_state")
        self.journal.pop("terminal_failed_owner_sha256")
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        self.make_namespace_attestation()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        self.assertEqual(
            context["native_restart_metadata"]["namespace_attestation_sha256"],
            hashlib.sha256(self.namespace_raw).hexdigest(),
        )

    def test_fresh_state_does_not_consume_native_stop_proof(self):
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes):
            with self.assertRaisesRegex(dev.BuildControlError, "retained session storage"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=True
                )

    def test_after_ready_stop_journal_consumes_identity_pinned_proof(self):
        self.configure_after_ready_journal()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        metadata = context["native_restart_metadata"]
        self.assertEqual(metadata["failure_kind"], "native-after-ready-failure")
        self.assertEqual(metadata["retained_ready_owner"], ready_owner())
        self.assertFalse(metadata["claim_pending"])

    def test_after_ready_stop_requires_terminal_ready_owner_pin(self):
        self.configure_after_ready_journal()
        self.terminal.pop("service_owner")
        self.terminal_raw = json.dumps(self.terminal, sort_keys=True).encode()
        self.journal["terminal_process_receipt"] = self.terminal
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "terminal ready owner differs"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )



class SupervisionFailedRecreateTests(unittest.TestCase):
    def setUp(self):
        import tempfile,copy
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.state=Path(self.temp.name)
        for name in ('runs','temp','recovery'):(self.state/'runs/docker-all/session-store'/name).mkdir(parents=True,exist_ok=True)
        self.pin=failed_owner();self.pin['state']='ready'
        for child in self.pin['children']:child['status']='running'
        self.owner=copy.deepcopy(self.pin);self.owner['state']='failed';self.owner['children'][1]['status']='exited_failure';self.owner['children'][0]['status']='exited_success'
        self.owner_raw=json.dumps(self.owner,sort_keys=True).encode()
        self.terminal={'schema':'fullmag.docker-process-tree.v1','state':'shutdown_unknown','error':stop_failed.SUPERVISION_FAILURE_ERROR,'shutdown_error':'runtime service owner is not ready','api_pid':3227,'api_exit_code':-15,'service_owner':self.pin}
        self.terminal_raw=json.dumps(self.terminal,sort_keys=True).encode()
        self.probe={'schema':stop_failed.SUPERVISION_FAILURE_SCHEMA,'process_receipt_sha256':'d'*64,'ready_pin_sha256':hashlib.sha256(json.dumps(self.pin,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest(),'failed_owner_sha256':hashlib.sha256(self.owner_raw).hexdigest(),'config_sha256':'c'*64,'windows_certificate_sha256':'e'*64,'accepted_store_id':'sha256:'+'f'*64,'api_pid':3227,'runtime_pid':3241,'terminal_children':self.owner['children'],'processes_absent':True,'runs_empty':True,'transients_empty':True,'affected_reservations_empty':True}
        self.previous={'attempt':'1'*32,'config_sha256':'2'*64,'state_root':str(self.state),'inputs':{'image_id':IMAGE_ID,'source_root':'D:/fixture'}}
        self.journal={'schema':'fullmag.stop-failed-admission.v1','state':'stopped-confirmed','failure_kind':stop_failed.SUPERVISION_FAILURE_KIND,'container_id':BACKEND_ID,'image_id':IMAGE_ID,'source_root':'D:/fixture','development_attempt':'1'*32,'compose_config_sha256':'2'*64,'namespace_processes_absent':True,'exit_code':1,'supervision_probe':self.probe,'previous_config_sha256':'c'*64,'terminal_process_receipt_sha256':hashlib.sha256(self.terminal_raw).hexdigest()}
    def run_context(self,*,fresh=False):
        def read(control,relative,*,optional=False):
            if relative.endswith('process-tree.json'):return self.terminal_raw
            if relative.endswith('OWNER.json'):return self.owner_raw
            return json.dumps(self.journal,sort_keys=True).encode()
        with patch.object(stop_unadmitted,'_control_bytes',side_effect=read),patch.object(dev,'_read_runtime_config_digest',return_value='c'*64):
            return dev._native_failed_stop_recovery_context(Mock(),self.previous,backend_id=BACKEND_ID,fresh_state=fresh)
    def test_dispatch_returns_existing_previous_config_contract_without_tokens(self):
        context=self.run_context();self.assertEqual(context['previous_config_sha256'],'c'*64);self.assertFalse(context['native_restart_metadata']['claim_pending']);self.assertNotIn('owner-token',json.dumps(context));self.assertNotIn('recovery_environment',context)
    def test_terminal_ready_pin_change_refuses(self):
        self.terminal['service_owner']['pid']=9999;self.terminal_raw=json.dumps(self.terminal).encode()
        with self.assertRaisesRegex(dev.BuildControlError,'pin/failed owner changed'):self.run_context()
    def test_failed_owner_bytes_change_refuses(self):
        self.owner_raw+=b' '
        with self.assertRaisesRegex(dev.BuildControlError,'pin/failed owner changed'):self.run_context()
    def test_terminal_receipt_bytes_change_refuses(self):
        self.terminal_raw+=b' '
        with self.assertRaisesRegex(dev.BuildControlError,'terminal receipt changed'):self.run_context()
    def test_config_change_refuses(self):
        self.journal['previous_config_sha256']='a'*64
        with self.assertRaisesRegex(dev.BuildControlError,'configuration changed'):self.run_context()
    def test_namespace_and_development_pins_refuse_drift(self):
        for key,value in [('namespace_processes_absent',False),('container_id','a'*64),('image_id','sha256:'+'b'*64),('development_attempt','3'*32),('compose_config_sha256','4'*64),('source_root','D:/other')]:
            original=self.journal[key];self.journal[key]=value
            with self.subTest(key=key),self.assertRaises(dev.BuildControlError):self.run_context()
            self.journal[key]=original
    def test_new_accepted_or_pending_work_refuses_recreation(self):
        for name in ('runs','temp','recovery'):
            p=self.state/'runs/docker-all/session-store'/name/'new';p.touch()
            with self.subTest(name=name),self.assertRaisesRegex(dev.BuildControlError,'accepted/pending'):self.run_context()
            p.unlink()
    def test_fresh_state_refuses(self):
        with self.assertRaises(dev.BuildControlError):self.run_context(fresh=True)



class CompletedRecreationContinuationTests(unittest.TestCase):
    def setUp(self):
        import tempfile,types,copy
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.args=types.SimpleNamespace(port=3202,attempt='1'*32,config_sha256='',completed_recreation_attempt='2'*32,completed_recreation_sha256='',fresh_state=False,recovery_authorization=None)
        self.selected=Path('D:/selected checkout');self.state=self.root/'state';self.state.mkdir()
        self.document={'name':'fixture','services':{'backend':{'gpus':[{'count':'all'}],'environment':{'FULLMAG_STARTUP_ENABLED':'0','FULLMAG_DOCKER_DEVICE_ACCESS':'gpu'}},'frontend':{'environment':{'FULLMAG_FRONTEND_HOST_PORT':'3202'}}}}
        self.args.config_sha256=hashlib.sha256(dev.canonical(self.document)).hexdigest()
        self.previous={'state':'succeeded','phase':'development','attempt':'1'*32,'compose_project':'fixture','config_sha256':self.args.config_sha256,'inputs':{'source_root':str(self.selected),'image_id':IMAGE_ID,'gpu_access_requested':'required','device_access':'gpu','gpu_preflight':'PASS'},'backend_container':BACKEND_ID,'frontend_container':'f'*64,'state_root':str(self.state),'backend_volumes':{'build':'build-volume','package':'package-volume','control':'control-volume'},'frontend_volume':'frontend-volume'}
        self.completed={'schema':'fullmag.docker-build-operation.v1','phase':'recreate-services','state':'succeeded','attempt':'2'*32,'compose_project':'fixture','fresh_state':False,'inputs':{'attempt':'1'*32,'config_sha256':self.args.config_sha256},'removed_containers':[BACKEND_ID,'f'*64],'previous_state_root':str(self.state),'retained_volumes':self.previous['backend_volumes'],'retained_frontend_volume':'frontend-volume'}
        self.cert={'image_id':IMAGE_ID,'restart_verified':True};self.recovery={'previous_config_sha256':'c'*64,'native_restart_metadata':{'schema':'fullmag.docker-runtime-supervision-restart.v1','claim_pending':False,'terminal_failed_owner_sha256':'e'*64}}
        self.control=Mock();self.control.project='fixture';self.control.read.return_value=self.document;self.drift={};self.absence=types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'Error: No such object: fixture')
    def invoke(self, host=None):
        import docker_volume_container_recovery as recovery,types
        if host is None:
            import windows_folder_host
            host=types.SimpleNamespace(HOST_CERT_PATH=windows_folder_host.HOST_CERT_PATH,
                OWNER_NAME=windows_folder_host.OWNER_NAME,
                read_owned_regular=Mock(return_value=json.dumps(self.cert).encode()))
        previous_raw=json.dumps(self.previous,sort_keys=True).encode();completed_raw=json.dumps(self.completed,sort_keys=True).encode()
        if not self.args.completed_recreation_sha256:self.args.completed_recreation_sha256=hashlib.sha256(completed_raw).hexdigest()
        def read(control,path,**kw):
            if path in self.drift:return self.drift[path]
            if path.endswith('/compose.json'):return dev.canonical(self.document)+b'\n'
            if path.endswith('/retained-containers.json'):return b'{}\n'
            return completed_raw if path.startswith('recreate-services/') else previous_raw
        with patch.object(stop_unadmitted,'_control_bytes',side_effect=read),patch.object(recovery,'docker_capture',return_value=self.absence),patch.object(dev,'_validate_removed_recreation_proof',return_value=({}, {}, self.recovery)),patch.object(dev,'_operator_probe_record_from_retained',return_value={}),patch.object(dev,'_session_host',return_value=host):
            return dev._completed_recreation_start_context(self.control,self.args,self.selected,{'runtime_root':self.root})
    def test_completed_removal_restores_exact_state_and_existing_r5_context(self):
        context=self.invoke();self.assertEqual(context['reuse_state']['state'],self.state);self.assertEqual(context['previous_config_sha256'],'c'*64);self.assertEqual(context['native_restart_metadata'],self.recovery['native_restart_metadata']);self.control.write.assert_not_called()
    @unittest.skipUnless(sys.platform.startswith("linux"), "requires the real Linux no-follow reader")
    def test_linux_completed_removal_uses_profile_paths_and_real_owned_reader(self):
        import linux_native_host as host
        for name in (Path(host.HOST_CERT_PATH).name,host.OWNER_NAME):
            (self.state/name).write_text(json.dumps(self.cert))
        # These old Windows files must not be consumed as a Linux certificate.
        (self.state/"windows-folder-host.json").write_text("invalid Windows certificate")
        (self.state/".fullmag-windows-folder-owner.json").write_text("invalid Windows owner")
        with patch('windows_folder_host.read_owned_regular',side_effect=AssertionError("Windows reader used on Linux")):
            context=self.invoke(host=host)
        self.assertEqual(context['reuse_state']['host_certificate'],self.state/Path(host.HOST_CERT_PATH).name)
        self.assertEqual(context['reuse_state']['owner_marker'],self.state/host.OWNER_NAME)
        self.assertEqual(context['reuse_state']['receipt']['image_id'],IMAGE_ID)
        self.assertEqual(context['native_restart_metadata'],self.recovery['native_restart_metadata'])
        self.control.write.assert_not_called()

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires the real Linux no-follow reader")
    def test_linux_continuation_preserves_owner_image_restart_and_startup_guards(self):
        import linux_native_host as host,copy
        for change in ('owner','image','restart','startup'):
            with self.subTest(change=change):
                cert=copy.deepcopy(self.cert);owner=copy.deepcopy(self.cert)
                if change=='owner':owner['image_id']='sha256:'+'d'*64
                elif change=='image':cert['image_id']=owner['image_id']='sha256:'+'d'*64
                elif change=='restart':cert['restart_verified']=owner['restart_verified']=False
                else:self.document['services']['backend']['environment']['FULLMAG_STARTUP_ENABLED']='1'
                (self.state/Path(host.HOST_CERT_PATH).name).write_text(json.dumps(cert))
                (self.state/host.OWNER_NAME).write_text(json.dumps(owner))
                self.args.config_sha256=hashlib.sha256(dev.canonical(self.document)).hexdigest()
                self.previous['config_sha256']=self.args.config_sha256
                self.completed['inputs']['config_sha256']=self.args.config_sha256
                self.args.completed_recreation_sha256=''
                with self.assertRaisesRegex(dev.BuildControlError,'session owner/admission/startup'):
                    self.invoke(host=host)

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires the real Linux no-follow reader")
    def test_linux_continuation_does_not_follow_certificate_or_owner_symlinks(self):
        import linux_native_host as host
        for name in (Path(host.HOST_CERT_PATH).name,host.OWNER_NAME):
            (self.state/name).write_text(json.dumps(self.cert))
        for name in (Path(host.HOST_CERT_PATH).name,host.OWNER_NAME):
            with self.subTest(name=name):
                path=self.state/name;path.unlink();target=self.root/'external-evidence.json'
                target.write_text(json.dumps(self.cert));path.symlink_to(target)
                with self.assertRaisesRegex(dev.storage.StorageError,'symlink/junction'):self.invoke(host=host)
                path.unlink();path.write_text(json.dumps(self.cert))

    def test_missing_old_ids_are_expected_but_present_old_id_refuses(self):
        self.invoke();self.absence.returncode=0
        with self.assertRaises(Exception):self.invoke()
    def test_absence_transport_unknown_is_not_proof(self):
        self.absence.stderr=b'Docker daemon unavailable'
        with self.assertRaises(Exception):self.invoke()
    def test_completed_terminal_sha_is_mandatory(self):
        self.args.completed_recreation_sha256='9'*64
        with self.assertRaisesRegex(dev.BuildControlError,'terminal digest'):self.invoke()
    def test_each_current_or_verified_raw_drift_refuses(self):
        for path in ('recreate-services/current.json','recreate-services/verified.json','recreate-services/attempts/'+'2'*32+'/receipt.json'):
            with self.subTest(path=path):
                self.drift={path:b'{}'}
                with self.assertRaisesRegex(dev.BuildControlError,'CAS differs'):self.invoke()
    def test_new_development_attempt_or_partial_unknown_current_refuses_replay(self):
        self.drift={'development/current.json':b'{"state":"outcome-unknown-resources-retained"}'}
        with self.assertRaisesRegex(dev.BuildControlError,'superseded'):self.invoke()
    def test_completed_outcome_unknown_or_failed_is_not_replayable(self):
        for state in ('outcome-unknown-resources-retained','failed-confirmed'):
            with self.subTest(state=state):
                self.completed['state']=state;self.args.completed_recreation_sha256=''
                with self.assertRaisesRegex(dev.BuildControlError,'removal/state/cache'):self.invoke()
    def test_removal_state_and_cache_pins_are_exact(self):
        import copy
        for key,value in [('removed_containers',[BACKEND_ID]),('previous_state_root','D:/other'),('retained_volumes',{}),('retained_frontend_volume','other'),('fresh_state',True)]:
            original=copy.deepcopy(self.completed[key]);self.completed[key]=value;self.args.completed_recreation_sha256=''
            with self.subTest(key=key),self.assertRaisesRegex(dev.BuildControlError,'removal/state/cache'):self.invoke()
            self.completed[key]=original
    def test_unpaired_or_incompatible_request_refuses(self):
        for key,value in [('completed_recreation_attempt','bad'),('completed_recreation_sha256','bad'),('fresh_state',True),('recovery_authorization','opaque-reference')]:
            original=getattr(self.args,key);setattr(self.args,key,value)
            with self.subTest(key=key),self.assertRaisesRegex(dev.BuildControlError,'paired exact pins'):self.invoke()
            setattr(self.args,key,original)
    def test_authenticated_drained_successor_continues_without_failed_owner_authority(self):
        from docker_volume_drained_successor import DrainedSuccessorContext
        self.recovery = DrainedSuccessorContext({"proof_sha256": "d" * 64})
        context = self.invoke()
        self.assertEqual(context["reuse_state"]["state"], self.state)
        self.assertNotIn("native_restart_metadata", context)
        self.assertNotIn("previous_config_sha256", context)
        self.assertNotIn("recovery_environment", context)
        self.control.write.assert_not_called()

    def test_missing_failed_owner_context_refuses(self):
        self.recovery={}
        with self.assertRaisesRegex(dev.BuildControlError,'failed-owner restart proof'):self.invoke()
    def test_source_or_old_config_drift_refuses(self):
        self.previous['inputs']['source_root']='D:/another'
        with self.assertRaisesRegex(dev.BuildControlError,'old development authority'):self.invoke()
    def test_changed_frontend_port_refuses(self):
        self.args.port=3203
        with self.assertRaisesRegex(dev.BuildControlError,'frontend port differs'):self.invoke()
    def test_old_development_verified_drift_refuses(self):
        self.drift={'development/verified.json':b'{}'}
        with self.assertRaisesRegex(dev.BuildControlError,'superseded'):self.invoke()
    def test_new_start_is_not_a_repeated_deletion(self):
        # Calling the real retained-operation branch must return through start
        # before Compose ps/inspect tries to find the deliberately removed IDs.
        import types,docker_dev as cli,docker_build_control as build
        import docker_volume_cancelled_activation_guard as cancelled
        self.args.repo_root=self.root;self.args.source_root=self.selected;self.args.port=3202
        def read_control(relative, *, optional=False):
            records = {
                'development/attempts/' + self.args.attempt + '/terminal.json': self.previous,
                'development/attempts/' + self.args.attempt + '/compose.json': self.document,
            }
            if relative in records:
                return records[relative]
            if optional:
                return None
            raise AssertionError('unexpected required control read: ' + relative)
        self.control.read.side_effect=read_control
        with patch.object(cli,'_require_native_windows'),patch.object(cli,'_select_source',return_value=(self.selected,{'runtime_root':self.root})),patch.object(cli,'_compose_identity',return_value={}),patch.object(build,'toolchain_configuration',return_value={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':'fixture'}}}}}),patch.object(dev,'BuildControl',return_value=self.control),patch.object(dev,'_operator_probe_record_from_retained',return_value={}),patch.object(dev,'_completed_recreation_start_context',return_value={'reuse_state':{'state':self.state},**self.recovery}),patch.object(dev,'start',return_value='continued') as start,patch.object(dev,'compose_capture') as compose,patch.object(cancelled,'_read_control_bytes',return_value=None) as read_cancelled:
            result=dev._retained_operation(self.args,recreate_services=True)
        self.assertEqual(result,'continued');start.assert_called_once();compose.assert_not_called();self.assertEqual(self.args.gpu_access,'required')
        read_cancelled.assert_called_once_with(self.control,cancelled.RECORD,optional=True)
    def test_fixed_shell_recipe_preserves_both_continuation_pins_with_spaces(self):
        import subprocess
        root=Path(__file__).resolve().parents[1];shell=(root/'scripts/just_storage_shell.sh').read_text()
        assignment=next(line.strip() for line in shell.splitlines() if line.strip().startswith('docker_dev_volume_recreate_pattern='))
        # just quote() always emits single quotes, even for alphanumeric pins.
        recipe='python "D:/selected checkout/scripts/docker_dev.py" --repo-root "D:/selected checkout" recreate-volume --attempt '+"'"+'1'*32+"' --config-sha256 '"+'a'*64+"' --source-root 'D:/selected checkout' --port '3202' --completed-recreation-attempt '"+'2'*32+"' --completed-recreation-sha256 '"+'b'*64+"'"
        code=assignment+'\nrecipe=$1\n[[ "$recipe" =~ $docker_dev_volume_recreate_pattern ]] || exit 9\nprintf "%s\\n%s\\n" "${BASH_REMATCH[9]}" "${BASH_REMATCH[10]}"'
        result=subprocess.run(['/bin/bash','-c',code,'fixture',recipe],capture_output=True,text=True,check=True)
        self.assertEqual(result.stdout.splitlines(),['2'*32,'b'*64])



class CompletedRemovalNativeProofTests(unittest.TestCase):
    """Real retained/native validators after authoritative Docker-ID deletion."""
    def setUp(self):
        import copy
        CompletedRecreationContinuationTests.setUp(self)
        self.selected=self.root/'selected';self.selected.mkdir()
        self.control.volume='fixture-control';self.control.namespace=''
        self.control.identity={'project_name':'fixture','project_id':'project','worktree_id':'worktree','checkout_kind':'worktree'}
        self.control.path=dev.BuildControl.path
        self.control.helper_args=lambda script:['fixture-helper',script]
        self.document={'name':'fixture','services':{},'volumes':{}}
        self.snapshot={}
        for role,identifier in [('backend',BACKEND_ID),('frontend','f'*64)]:
            labels={'com.docker.compose.project':'fixture','com.docker.compose.service':role,
                'org.fullmag.source.worktree-id':'worktree'}
            environment={'FULLMAG_STARTUP_ENABLED':'0','FULLMAG_DOCKER_DEVICE_ACCESS':'gpu'} if role=='backend' else {'FULLMAG_FRONTEND_HOST_PORT':'3202'}
            volumes=[{'type':'bind','source':str(self.selected),'target':'/opt/fullmag/source','read_only':True}]
            technical=[('/build','build'),('/opt/fullmag/package','package'),('/opt/fullmag/control','control')] if role=='backend' else [('/state/development','frontend'),('/opt/fullmag/control','control')]
            for target,name in technical:
                self.document['volumes'][name]={'name':'fixture-'+name}
                volumes.append({'type':'volume','source':name,'target':target,'read_only':role=='frontend' and name=='control'})
            self.document['services'][role]={'image':IMAGE_ID,'labels':labels,'environment':environment,'volumes':volumes,
                'x-fullmag-daemon-binds':{'/opt/fullmag/source':str(self.selected)}}
            self.snapshot[role]={'Id':identifier,'Image':IMAGE_ID,
                'Config':{'Labels':copy.deepcopy(labels),'Env':[k+'='+v for k,v in environment.items()]},
                'HostConfig':{'ReadonlyRootfs':True,'Privileged':False},
                'Mounts':[{'Destination':m['target'],'Type':m['type'],'RW':not m['read_only'],
                    **({'Source':m['source']} if m['type']=='bind' else {'Name':'fixture-'+m['source']})} for m in volumes],
                'State':{'Running':False,'StartedAt':'2026-10-19T10:00:00.000000000Z',
                    'FinishedAt':'2026-10-19T10:00:10.000000000Z','ExitCode':1 if role=='backend' else 0}}
        self.control.read.return_value=self.document
        self.document['services']['backend']['gpus']=[{'count':'all'}]
        self.document['services']['frontend']['ports']=[{'host_ip':'127.0.0.1','mode':'ingress','protocol':'tcp','target':8080,'published':'3202'}]
        self.args.config_sha256=hashlib.sha256(dev.canonical(self.document)).hexdigest()
        self.args.gpu_access='required';self.args.include_untracked=[]
        self.previous['config_sha256']=self.args.config_sha256
        self.previous['inputs'].update(source_root=str(self.selected),source_project_id='project',
            source_worktree_id='worktree',source_checkout_kind='worktree',
            native_failed_restart={'container_id':'a'*64})  # An older generation is never copied.
        self.completed['inputs']['config_sha256']=self.args.config_sha256
        self.completed['control_volume']=self.control.volume
        probe=after_ready_native_probe();ready=probe['process_receipt']['service_owner'];owner=probe['failed_owner']
        owner_raw=dev.canonical(owner)+b'\n';probe['failed_owner_sha256']=hashlib.sha256(owner_raw).hexdigest()
        terminal={**terminal_receipt(),'service_owner':ready}
        self.config_raw=b'{"schema_version":"runtime_service.v1"}\n'
        self.journal={'schema':'fullmag.stop-failed-admission.v1','state':'stopped-confirmed',
            'failure_kind':'native-after-ready-failure','container_id':BACKEND_ID,'image_id':IMAGE_ID,'exit_code':1,
            'failure_receipt':{'sha256':'d'*64,'receipt':probe['process_receipt']},'native_failure_probe':probe,
            'retained_ready_owner':ready,'terminal_process_receipt':terminal,'terminal_retained_ready_owner':ready,
            'terminal_failed_owner':owner,'terminal_failed_owner_sha256':hashlib.sha256(owner_raw).hexdigest(),
            'container_state':NativeFailedRecreateTests.container_state(),
            'previous_config_sha256':hashlib.sha256(self.config_raw).hexdigest()}
        base='recreate-services/attempts/'+self.args.completed_recreation_attempt
        prior='development/attempts/'+self.args.attempt
        completed_raw=dev.canonical(self.completed)+b'\n';prior_raw=dev.canonical(self.previous)+b'\n'
        self.args.completed_recreation_sha256=hashlib.sha256(completed_raw).hexdigest()
        self.records={base+'/'+name:completed_raw for name in ('terminal.json','receipt.json')}
        self.records.update({name:completed_raw for name in ('recreate-services/current.json','recreate-services/verified.json')})
        self.records.update({name:prior_raw for name in (prior+'/terminal.json','development/current.json','development/verified.json')})
        self.records.update({prior+'/compose.json':dev.canonical(self.document)+b'\n',
            base+'/retained-containers.json':dev.canonical(self.snapshot)+b'\n',
            'verification/stop-failed-'+BACKEND_ID+'.json':dev.canonical(self.journal)+b'\n',
            'runtime-control/runtime-service/process-tree.json':dev.canonical(terminal)+b'\n',
            'runtime-control/runtime-services/OWNER.json':owner_raw})
        self.calls=[]

    def invoke(self, ordinary=False, current_operation=None, expected_proof=None):
        import types,docker_volume_container_recovery as recovery
        def read(control,path,*,optional=False):
            if path in self.records:return self.records[path]
            if optional:return None
            raise AssertionError('Unexpected proof read: '+path)
        def docker(*args,**kwargs):
            self.calls.append(args)
            if args[0]=='inspect':return CompletedProcess(args,1,b'',('Error: No such object: '+args[1]).encode())
            if args[0]=='ps':return CompletedProcess(args,0,b'',b'')
            raise AssertionError('Unexpected Docker mutation: '+str(args))
        host=types.SimpleNamespace(HOST_CERT_PATH='/run/fullmag/linux-native-host.json',
            OWNER_NAME='.fullmag-linux-native-owner.json',read_owned_regular=lambda path:json.dumps(self.cert).encode())
        with patch.object(stop_unadmitted,'_control_bytes',side_effect=read), \
             patch.object(dev,'docker_capture',side_effect=docker), \
             patch.object(recovery,'docker_capture',side_effect=docker), \
             patch.object(reconcile,'docker_capture',side_effect=AssertionError('Removed backend must not be inspected as stopped')), \
             patch.object(dev,'docker_text',return_value=json.dumps([{'Id':IMAGE_ID,'Config':{}}])), \
             patch.object(dev,'bounded_capture',return_value=CompletedProcess([],0,self.config_raw,b'')), \
             patch.object(dev,'_operator_probe_record_from_retained',return_value={}), \
             patch.object(dev,'_session_host',return_value=host):
            if ordinary:
                self.args.resume_recreation=self.args.completed_recreation_attempt
                return dev._validate_recreation_resume_records(self.args,self.control,self.selected,self.control.identity,
                    current_operation=current_operation,expected_proof=expected_proof)
            return dev._completed_recreation_start_context(self.control,self.args,self.selected,{'runtime_root':self.root})

    def test_completed_removal_revalidates_real_native_proof_without_stopped_inspection(self):
        context=self.invoke()
        self.assertEqual(context['native_restart_metadata']['container_id'],BACKEND_ID)
        self.assertEqual(context['native_restart_metadata']['failure_kind'],'native-after-ready-failure')
        self.assertEqual(context['native_restart_metadata']['journal_sha256'],hashlib.sha256(self.records['verification/stop-failed-'+BACKEND_ID+'.json']).hexdigest())
        self.assertEqual(context['previous_config_sha256'],hashlib.sha256(self.config_raw).hexdigest())
        self.assertTrue(any(call[0]=='ps' for call in self.calls))
        self.control.write.assert_not_called()

    def test_snapshot_journal_owner_process_and_cas_tampering_are_refused(self):
        import copy
        base='recreate-services/attempts/'+self.args.completed_recreation_attempt
        journal='verification/stop-failed-'+BACKEND_ID+'.json'
        cases=[(base+'/retained-containers.json',lambda value:value['backend']['State'].update(FinishedAt='changed')),
            (base+'/retained-containers.json',lambda value:value['frontend']['Config']['Labels'].update({'com.docker.compose.project':'foreign'})),
            (journal,lambda value:value['container_state'].update(finished_at='changed')),
            ('runtime-control/runtime-services/OWNER.json',lambda value:value.update(pid=9999)),
            ('runtime-control/runtime-service/process-tree.json',lambda value:value.update(api_exit_code=9)),
            ('recreate-services/verified.json',lambda value:value.update(state='failed'))]
        original=copy.deepcopy(self.records)
        for path,mutate in cases:
            with self.subTest(path=path):
                self.records=copy.deepcopy(original);value=json.loads(self.records[path]);mutate(value)
                self.records[path]=dev.canonical(value)+b'\n'
                with self.assertRaises(dev.BuildControlError):self.invoke()

    def test_recheck_pins_even_nonsemantic_retained_snapshot_changes(self):
        before=self.invoke()
        path='recreate-services/attempts/'+self.args.completed_recreation_attempt+'/retained-containers.json'
        snapshot=json.loads(self.records[path]);snapshot['frontend']['Name']='/retained-name-changed'
        self.records[path]=dev.canonical(snapshot)+b'\n'
        after=self.invoke()
        self.assertEqual(before['native_restart_metadata'],after['native_restart_metadata'])
        self.assertNotEqual(before['reuse_state'],after['reuse_state'])

    def test_runtime_config_digest_drift_is_refused(self):
        self.config_raw=b'{"changed":true}'
        with self.assertRaisesRegex(dev.BuildControlError,'runtime configuration digest differs'):self.invoke()

    def owned_start_lease(self):
        proof=self.invoke(ordinary=True)['proof']
        token='8'*32
        operation={'receipt':{'attempt':token,'phase':'development','state':'starting',
            'compose_project':self.control.project,'control_volume':self.control.volume,
            'inputs':{'recreation_resume':{'proof_sha256':hashlib.sha256(dev.canonical(proof)).hexdigest()}}},
            'root':'development/attempts/'+token,'lease_ready':True,'helper_container_id':'9'*64}
        self.records['active']=(token+'\n').encode()
        self.records[operation['root']+'/receipt.json']=dev.canonical(operation['receipt'])+b'\n'
        self.control._active_operation=operation
        self.control._pin_operation_helper.return_value=operation['helper_container_id']
        return operation,proof

    def test_revalidation_accepts_exact_owned_active_start_lease(self):
        operation,proof=self.owned_start_lease()
        observed=self.invoke(ordinary=True,current_operation=operation,expected_proof=proof)
        self.assertEqual(observed['proof'],proof)
        self.control._pin_operation_helper.assert_called_once_with(operation)
        self.control.write.assert_not_called()

    def test_revalidation_refuses_foreign_active_start_lease(self):
        operation,proof=self.owned_start_lease()
        self.control._active_operation={}
        with self.assertRaisesRegex(dev.BuildControlError,'exact active start lease'):
            self.invoke(ordinary=True,current_operation=operation,expected_proof=proof)
        self.control._pin_operation_helper.assert_not_called()

    def test_revalidation_refuses_changed_owned_lease_receipt(self):
        operation,proof=self.owned_start_lease()
        self.records[operation['root']+'/receipt.json']=b'changed'
        with self.assertRaisesRegex(dev.BuildControlError,'receipt/helper changed'):
            self.invoke(ordinary=True,current_operation=operation,expected_proof=proof)

    def test_revalidation_refuses_replaced_owned_lease_helper(self):
        operation,proof=self.owned_start_lease()
        self.control._pin_operation_helper.return_value='0'*64
        with self.assertRaisesRegex(dev.BuildControlError,'receipt/helper changed'):
            self.invoke(ordinary=True,current_operation=operation,expected_proof=proof)

    def test_revalidation_refuses_helper_repin_that_mutates_operation(self):
        operation,proof=self.owned_start_lease()
        def replaced(current):
            current['helper_container_id']='0'*64
            return current['helper_container_id']
        self.control._pin_operation_helper.side_effect=replaced
        with self.assertRaisesRegex(dev.BuildControlError,'receipt/helper changed'):
            self.invoke(ordinary=True,current_operation=operation,expected_proof=proof)

    def test_revalidation_refuses_other_active_token(self):
        operation,proof=self.owned_start_lease()
        self.records['active']=b'0'*32+b'\n'
        with self.assertRaisesRegex(dev.BuildControlError,'exact active start lease'):
            self.invoke(ordinary=True,current_operation=operation,expected_proof=proof)

    def test_ordinary_resume_still_refuses_active_lease_before_removed_proof(self):
        self.records['active']=b'3'*32+b'\n'
        with self.assertRaisesRegex(dev.BuildControlError,'lease is still active'):self.invoke(ordinary=True)
        # Immutable completed-start rechecking is safe under its already-owned
        # start lease; it cannot create/release a lease or mutate the daemon.
        context=self.invoke()
        self.assertEqual(context['native_restart_metadata']['container_id'],BACKEND_ID)
        self.control.write.assert_not_called()


class DrainedSuccessorShellBoundaryTests(unittest.TestCase):
    def shell_argv(self, action, suffix):
        import subprocess
        root = Path(__file__).resolve().parents[1]
        shell = (root / 'scripts/just_storage_shell.sh').read_text()
        start = shell.index('  *"scripts/docker_dev.py"*)')
        end = shell.index('\n    ;;', start)
        body = shell[shell.index('\n', start) + 1:end]
        final = 'exec "${python_cmd}" "${script_dir}/docker_dev.py" "${docker_dev_args[@]}"'
        self.assertEqual(body.count(final), 1)
        body = body.replace(final, 'printf "%s' + chr(92) + 'n" "${docker_dev_args[@]}"')
        recipe = ('python "D:/selected checkout/scripts/docker_dev.py" --repo-root "D:/selected checkout" '
            + action + " --attempt '" + '1' * 32 + "' --config-sha256 '" + 'a' * 64
            + "' --source-root 'D:/selected checkout' --port '3203'" + suffix)
        result = subprocess.run(['/bin/bash', '-euc', "repo_root='D:/selected checkout'\nrecipe=$1\n" + body,
                                 'fixture', recipe], capture_output=True)
        return result, result.stdout.decode().splitlines()

    def test_idle_stop_passes_without_saved_authoring_checkpoint(self):
        result, args = self.shell_argv('restart-idle-volume', ' --stop-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-1], '--stop-only')
        self.assertEqual(args.count('--stop-only'), 1)
        self.assertNotIn('--saved-authoring-checkpoint', args)

    def test_saved_authoring_stop_preserves_its_exact_pins(self):
        suffix = " --saved-authoring-checkpoint 'verification/checkpoint.json' --saved-authoring-checkpoint-sha256 '" + 'b' * 64 + "' --stop-only"
        result, args = self.shell_argv('restart-idle-volume', suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-5:], ['--saved-authoring-checkpoint', 'verification/checkpoint.json',
            '--saved-authoring-checkpoint-sha256', 'b' * 64, '--stop-only'])

    def test_recreation_preserves_completed_and_drained_proof_pairs(self):
        suffix = (" --completed-recreation-attempt '" + '2' * 32
            + "' --completed-recreation-sha256 '" + 'b' * 64
            + "' --drained-successor-proof '/opt/fullmag/control/verification/proof.json'"
            + " --drained-successor-proof-sha256 '" + 'c' * 64 + "'")
        result, args = self.shell_argv('recreate-volume', suffix)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-8:], ['--completed-recreation-attempt', '2' * 32,
            '--completed-recreation-sha256', 'b' * 64, '--drained-successor-proof',
            '/opt/fullmag/control/verification/proof.json', '--drained-successor-proof-sha256', 'c' * 64])
        self.assertEqual(args[args.index('--source-root') + 1], 'D:/selected checkout')

    def test_unpaired_proof_and_unexpected_shell_tail_are_refused(self):
        for suffix in (" --drained-successor-proof '/opt/fullmag/control/verification/proof.json'",
                       ' --stop-only; echo injected'):
            with self.subTest(suffix=suffix):
                result, args = self.shell_argv('recreate-volume', suffix)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b'')


class DrainedSuccessorDispatchTests(unittest.TestCase):
    def test_explicit_successor_validates_current_drain_without_replaying_old_failure(self):
        import docker_volume_drained_successor as successor
        context = successor.DrainedSuccessorContext({"terminal_sha256": "d" * 64})
        control, previous, document, observed = Mock(), {}, {}, {"backend": {}, "frontend": {}}
        pins = ("/opt/fullmag/control/verification/proof.json", "a" * 64)
        with patch.object(successor, "retained_context", return_value=context) as validate, \
                patch.object(dev, "_native_failed_stop_recovery_context") as legacy:
            actual = dev._retained_recovery_context(control, previous, document, fresh_state=False,
                actual=observed, drained_successor=pins)
        self.assertIs(actual, context)
        validate.assert_called_once_with(control, previous, document, observed, *pins,
                                         removed_container_proof=None)
        legacy.assert_not_called()
        self.assertEqual(dict(actual), {})

    def test_successor_never_authorizes_fresh_storage(self):
        import docker_volume_drained_successor as successor
        with patch.object(successor, "retained_context") as validate:
            with self.assertRaisesRegex(dev.BuildControlError, "retained storage"):
                dev._retained_recovery_context(Mock(), {}, {}, fresh_state=True,
                    drained_successor=("proof", "a" * 64), actual={})
        validate.assert_not_called()


class DrainedSuccessorProofTests(unittest.TestCase):
    """Historical failure is superseded only by this exact later native drain."""

    def setUp(self):
        import copy
        import docker_volume_drained_successor as successor
        self.successor = successor
        self.copy = copy.deepcopy
        self.control = Mock(project="fullmag-worktree-test", volume="test-control")
        self.document = {"name": self.control.project, "services": {
            "backend": {"image": IMAGE_ID}, "frontend": {"image": IMAGE_ID}}}
        self.config_sha = self.sha(dev.canonical(self.document))
        self.previous = {"attempt": "1" * 32, "state": "succeeded",
            "compose_project": self.control.project, "config_sha256": self.config_sha,
            "state_root": "/state", "inputs": {"source_root": "/checkout", "image_id": IMAGE_ID},
            "backend_container": BACKEND_ID, "frontend_container": "f" * 64}
        self.actual = {}
        for service, identifier, exit_code in [("backend", BACKEND_ID, 0), ("frontend", "f" * 64, 1)]:
            self.actual[service] = {"Id": identifier, "Image": IMAGE_ID, "Mounts": [],
                "HostConfig": {}, "Config": {"Labels": {"com.docker.compose.project": self.control.project,
                    "com.docker.compose.service": service}},
                "State": {"Running": False, "OOMKilled": False, "Status": "exited", "ExitCode": exit_code,
                    "StartedAt": "new-start", "FinishedAt": "new-finish"}}
        ready = ready_owner()
        ready["owner_token"] = "11111111-1111-4111-8111-111111111111"
        ready["process_start_token"] = "22222222-2222-4222-8222-222222222222"
        drained = self.copy(ready)
        drained["state"] = "drained"
        drained["children"] = [{**child, "status": "exited_success"} for child in drained["children"]]
        self.terminal = {"schema": "fullmag.docker-process-tree.v1", "state": "drained",
            "service_owner": ready, "terminal_service_owner": drained, "api_exit_code": 0}
        self.records = {}
        self.put("runtime-control/runtime-service/process-tree.json", self.terminal)
        self.put("runtime-control/runtime-services/OWNER.json", drained)
        self.put("runtime-control/runtime-services/docker-client-" + ready["owner_token"] + ".json", ready)
        old_probe = after_ready_native_probe()
        self.journal = {"schema": "fullmag.stop-failed-admission.v1", "state": "stopped-confirmed",
            "failure_kind": "native-after-ready-failure", "container_id": BACKEND_ID, "image_id": IMAGE_ID,
            "failure_receipt": {"sha256": "d" * 64, "receipt": old_probe["process_receipt"]},
            "retained_ready_owner": old_probe["process_receipt"]["service_owner"],
            "native_failure_probe": old_probe, "container_state": {"started_at": "old-start"}}
        journal_sha = self.put("verification/stop-failed-" + BACKEND_ID + ".json", self.journal)
        self.stop_root = "iteration/attempts/" + "2" * 32
        snapshot_sha = self.put(self.stop_root + "/idle-stop-containers.json", self.actual)
        self.put(self.stop_root + "/idle-preflight.json", {"status": "ok", "active_session": False})
        self.drain = {"schema": "fullmag.docker-idle-restart-drain.v1",
            "backend_container_id": BACKEND_ID, "process_receipt": self.terminal,
            "process_receipt_sha256": self.sha(self.records["runtime-control/runtime-service/process-tree.json"])}
        self.put(self.stop_root + "/backend-drain.json", self.drain)
        self.stop = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
            "state": "succeeded", "attempt": "2" * 32, "compose_project": self.control.project,
            "control_volume": self.control.volume, "inputs": {"attempt": self.previous["attempt"],
                "config_sha256": self.config_sha}, "backend_container": BACKEND_ID,
            "frontend_container": "f" * 64, "idle_backend_stopped": True,
            "config_sha256": self.config_sha, "idle_stop_containers_sha256": snapshot_sha}
        self.request = {"schema": "fullmag.drained-successor-proof.v1",
            "stop": {"attempt": "2" * 32, "terminal_sha256": "0" * 64},
            "journal_sha256": journal_sha, "native_config_sha256": "c" * 64}
        self.proof = "/opt/fullmag/control/verification/drained-proof.json"
        self.refresh_stop()

    @staticmethod
    def sha(raw):
        return hashlib.sha256(raw).hexdigest()

    def put(self, path, value):
        raw = dev.canonical(value)
        self.records[path] = raw
        return self.sha(raw)

    def refresh_stop(self):
        sha = self.put(self.stop_root + "/terminal.json", self.stop)
        self.put(self.stop_root + "/receipt.json", self.stop)
        self.request["stop"]["terminal_sha256"] = sha
        self.proof_sha = self.put("verification/drained-proof.json", self.request)

    def invoke(self, *, removed=None):
        def read(_control, path, **kwargs):
            if path not in self.records:
                raise dev.BuildControlError("missing test record: " + path)
            return self.records[path]
        with patch.object(self.successor, "_control_bytes", side_effect=read), \
                patch.object(self.successor, "_ledger_observation", return_value="e" * 64), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            return self.successor.retained_context(self.control, self.previous, self.document,
                self.actual, self.proof, self.proof_sha, removed_container_proof=removed)

    def test_exact_ordinary_drain_preserves_failed_frontend_without_authority(self):
        context = self.invoke()
        self.assertIsInstance(context, self.successor.DrainedSuccessorContext)
        self.assertEqual(dict(context), {})
        self.assertEqual(context.witness["containers"]["frontend"]["exit_code"], 1)
        witness = context.witness
        witness["terminal_sha256"] = "changed"
        self.assertNotEqual(context.witness["terminal_sha256"], "changed")
        self.control.write.assert_not_called()

    def test_mount_order_is_nonsemantic_but_all_mount_fields_remain_pinned(self):
        self.actual["backend"]["Mounts"] = [
            {"Destination": "/alpha", "Type": "bind", "Source": "/source-a", "RW": False},
            {"Destination": "/beta", "Type": "volume", "Name": "data", "RW": True}]
        self.stop["idle_stop_containers_sha256"] = self.put(
            self.stop_root + "/idle-stop-containers.json", self.copy(self.actual))
        self.refresh_stop()
        before = self.invoke().witness
        self.actual["backend"]["Mounts"].reverse()
        self.assertEqual(self.invoke().witness, before)
        self.actual["backend"]["Mounts"][0]["RW"] = False
        with self.assertRaisesRegex(dev.BuildControlError, "snapshot changed"):
            self.invoke()

    def test_rejects_changed_or_missing_proof_and_closed_fields(self):
        for mutation in ("digest", "unknown", "no-config", "path"):
            with self.subTest(mutation=mutation):
                original = self.copy(self.request)
                old_sha, old_path = self.proof_sha, self.proof
                if mutation == "digest": self.proof_sha = "9" * 64
                if mutation == "unknown": self.request["unexpected"] = True; self.refresh_stop()
                if mutation == "no-config": self.request.pop("native_config_sha256"); self.refresh_stop()
                if mutation == "path": self.proof = "/opt/fullmag/control/verification/../drained-proof.json"
                with self.assertRaises((dev.BuildControlError, KeyError)):
                    self.invoke()
                self.request = original
                self.proof, self.proof_sha = old_path, old_sha
                self.refresh_stop()

    def test_rejects_stop_without_success_idle_observation_or_snapshot(self):
        for field, value in (("state", "running"), ("idle_backend_stopped", False),
                             ("config_sha256", "9" * 64), ("idle_stop_containers_sha256", None)):
            with self.subTest(field=field):
                old = self.stop[field]
                self.stop[field] = value; self.refresh_stop()
                with self.assertRaises(dev.BuildControlError): self.invoke()
                self.stop[field] = old; self.refresh_stop()
        self.put(self.stop_root + "/idle-preflight.json", {"status": "ok", "active_session": True})
        with self.assertRaisesRegex(dev.BuildControlError, "inactive session"):
            self.invoke()

    def test_rejects_restarted_oom_running_or_nonzero_backend(self):
        for field, value in (("StartedAt", "another"), ("FinishedAt", "another"), ("Running", True),
                             ("OOMKilled", True), ("ExitCode", 1)):
            with self.subTest(field=field):
                old = self.actual["backend"]["State"][field]
                self.actual["backend"]["State"][field] = value
                with self.assertRaises(dev.BuildControlError): self.invoke()
                self.actual["backend"]["State"][field] = old

    def test_rejects_changed_current_drain_owner_ready_pin_and_native_config(self):
        mutations = [
            ("runtime-control/runtime-service/process-tree.json", {**self.terminal, "state": "shutdown_unknown"}),
            ("runtime-control/runtime-services/OWNER.json", {**self.terminal["terminal_service_owner"], "state": "failed"}),
            ("runtime-control/runtime-services/docker-client-" + self.terminal["service_owner"]["owner_token"] + ".json",
             {**self.terminal["service_owner"], "pid": 999}),
        ]
        for path, value in mutations:
            with self.subTest(path=path):
                old = self.records[path]
                self.put(path, value)
                with self.assertRaises(dev.BuildControlError): self.invoke()
                self.records[path] = old
        self.request["native_config_sha256"] = "a" * 64; self.refresh_stop()
        with self.assertRaisesRegex(dev.BuildControlError, "configuration"):
            self.invoke()

    def test_rejects_old_incarnation_even_with_consistent_new_request_hash(self):
        self.journal["container_state"]["started_at"] = "new-start"
        self.request["journal_sha256"] = self.put("verification/stop-failed-" + BACKEND_ID + ".json", self.journal)
        self.refresh_stop()
        with self.assertRaisesRegex(dev.BuildControlError, "later container incarnation"):
            self.invoke()

    def test_completed_recreation_requires_exact_drained_snapshot(self):
        state = self.actual["backend"]["State"]
        proof = {"schema": "fullmag.docker-removed-recreation-container.v1",
            "container_id": BACKEND_ID, "frontend_container": "f" * 64, "image_id": IMAGE_ID,
            "container_state": {"id": BACKEND_ID, "image": IMAGE_ID, "started_at": state["StartedAt"],
                "finished_at": state["FinishedAt"], "exit_code": 0}}
        context = self.invoke(removed=proof)
        self.assertEqual(context.witness, self.invoke().witness)
        for field in ("container_id", "frontend_container", "image_id", "container_state"):
            with self.subTest(field=field):
                changed = {**proof, field: None}
                with self.assertRaisesRegex(dev.BuildControlError, "snapshot"):
                    self.invoke(removed=changed)


    def test_ledger_read_is_bound_readonly_and_rejects_active_reservations(self):
        import docker_group_ledger as ledger
        expected = {"volume_name": "fullmag-dev-ledger-test", "environment": {"LEDGER_BINDING": "test"}}
        actual = self.copy(self.actual)
        actual["backend"]["Mounts"] = [{"Destination": ledger.MOUNT_TARGET, "Type": "volume",
            "Name": expected["volume_name"], "Driver": "local", "RW": True}]
        actual["backend"]["Config"]["Env"] = ["LEDGER_BINDING=test"]
        self.control.helper_args.return_value = ["docker", "run", "--entrypoint", "/bin/bash", "image"]
        for state in ("released", "active", "unknown"):
            with self.subTest(state=state), \
                    patch.object(ledger, "retained_profile", return_value=expected), \
                    patch.object(self.successor, "bounded_capture",
                        return_value=CompletedProcess([], 0, json.dumps({"schema_version": "host_resource_ledger.v4", "reservations": [{"state": state}]}).encode(), b"")) as capture:
                if state == "released":
                    result = self.successor._ledger_observation(self.control, self.document, actual)
                    self.assertRegex(result, r"^[0-9a-f]{64}$")
                    self.assertIn("type=volume,src=fullmag-dev-ledger-test,dst=/ledger,readonly,volume-nocopy",
                                  capture.call_args.args[0])
                    self.assertIn("flock -n 9", self.control.helper_args.call_args.args[0])
                else:
                    with self.assertRaisesRegex(dev.BuildControlError, "reservation"):
                        self.successor._ledger_observation(self.control, self.document, actual)

    def test_ledger_foreign_mount_or_failed_reader_cannot_authorize_drain(self):
        import docker_group_ledger as ledger
        expected = {"volume_name": "fullmag-dev-ledger-test", "environment": {}}
        with patch.object(ledger, "retained_profile", return_value=expected), \
                patch.object(self.successor, "bounded_capture") as capture:
            with self.assertRaisesRegex(dev.BuildControlError, "ledger mount"):
                self.successor._ledger_observation(self.control, self.document, self.actual)
            capture.assert_not_called()
        actual = self.copy(self.actual)
        actual["backend"]["Mounts"] = [{"Destination": ledger.MOUNT_TARGET, "Type": "volume",
            "Name": expected["volume_name"], "Driver": "local", "RW": True}]
        self.control.helper_args.return_value = ["docker", "run", "--entrypoint", "/bin/bash", "image"]
        with patch.object(ledger, "retained_profile", return_value=expected), \
                patch.object(self.successor, "bounded_capture", return_value=CompletedProcess([], 1, b"", b"locked")):
            with self.assertRaisesRegex(dev.BuildControlError, "writer active"):
                self.successor._ledger_observation(self.control, self.document, actual)



    def test_ledger_unknown_schema_or_non_object_reservations_are_refused(self):
        import docker_group_ledger as ledger
        expected = {"volume_name": "fullmag-dev-ledger-test", "environment": {}}
        actual = self.copy(self.actual)
        actual["backend"]["Mounts"] = [{"Destination": ledger.MOUNT_TARGET, "Type": "volume",
            "Name": expected["volume_name"], "Driver": "local", "RW": True}]
        self.control.helper_args.side_effect = lambda script: [
            "docker", "run", "--entrypoint", "/bin/bash", "image"]
        cases = [
            {"schema_version": "host_resource_ledger.v3", "reservations": []},
            {"reservations": []},
            {"schema_version": "host_resource_ledger.v4", "reservations": {}},
            {"schema_version": "host_resource_ledger.v4", "reservations": [None]},
            [],
        ]
        for value in cases:
            with self.subTest(value=value), \
                    patch.object(ledger, "retained_profile", return_value=expected), \
                    patch.object(self.successor, "bounded_capture",
                        return_value=CompletedProcess([], 0, json.dumps(value).encode(), b"")):
                with self.assertRaises(dev.BuildControlError):
                    self.successor._ledger_observation(self.control, self.document, actual)


if __name__ == "__main__":
    unittest.main()
