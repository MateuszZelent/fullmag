"""Focused source-only regressions for the native failed-admission stop draft."""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


MODULE_PATH = Path(__file__).with_name("docker_volume_stop_failed.py")
sys.path.insert(0, str(Path(__file__).resolve().parent))
SPEC = importlib.util.spec_from_file_location("stop_failed_draft", MODULE_PATH)
assert SPEC and SPEC.loader
stop = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stop)


def owner(*, compute_status: str = "exited_success") -> dict[str, object]:
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
        "build_commit": "a" * 40,
        "build_snapshot": "b" * 64,
        "compute_pool_id": "compute-pool",
        "preparation_pool_id": "preparation-pool",
        "compute_pool_generation": 7,
        "preparation_pool_generation": 8,
        "acquired_at": "2026-10-19T10:00:00Z",
        "heartbeat_at": "2026-10-19T10:00:01Z",
        "children": [
            {"role": "compute", "pid": 3250, "status": compute_status},
            {"role": "preparation", "pid": 3251, "status": "exited_success"},
        ],
    }


def ready_owner(*, compute_status: str = "running") -> dict[str, object]:
    value = owner(compute_status=compute_status)
    value["state"] = "ready"
    value["children"] = [
        {**child, "status": compute_status if child["role"] == "compute" else "running"}
        for child in value["children"]
    ]
    return value


def api_start_failure_probe(**changes: object) -> dict[str, object]:
    document = probe(
        process_receipt={
            **probe()["process_receipt"],
            "error": "API binding did not become ready: API loopback probe failed",
        },
        failed_owner=owner(compute_status="exited_failure"),
        owner_pid_exists=False,
        child_pids_exist=False,
        failure_mode=stop.API_START_FAILURE_MODE,
    )
    document.update(changes)
    return document


def probe(**changes: object) -> dict[str, object]:
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime CLI failed: native service exited during startup",
    }
    document = {
        "schema": stop.NATIVE_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "a" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": "b" * 64,
        "failed_owner": owner(),
        "api_pid_exists": False,
        "native_processes_live": False,
        "startup_enabled": None,
        "legacy_activation_marker_exists": False,
        "reservation_states": ["released"],
        "lease_states": ["released"],
        "active_lease_count": 0,
    }
    document.update(changes)
    return document


def after_ready_probe(**changes: object) -> dict[str, object]:
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime service owner observation failed during supervision",
        "service_owner": ready_owner(),
    }
    failed = owner(compute_status="exited_failure")
    document = {
        "schema": stop.NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "a" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": "b" * 64,
        "failed_owner": failed,
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
    document.update(changes)
    return document


class NativeFailedStopTests(unittest.TestCase):
    @staticmethod
    def _extract_native_processes_live(os_mock):
        """Compile only the image-owned process scanner from the probe."""
        tree = ast.parse(stop._native_failure_probe_script(), mode="exec")
        function = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "native_processes_live"
        )
        module = ast.Module(body=[function], type_ignores=[])
        namespace = {"os": os_mock, "pathlib": __import__("pathlib")}
        exec(compile(ast.fix_missing_locations(module), "<native-process-probe>", "exec"), namespace)
        return namespace["native_processes_live"]

    def test_accepts_api_start_failure_receipt_with_failed_compute_child(self):
        value = stop._validate_native_failure_probe(
            api_start_failure_probe(), "a" * 64, api_start_failure=True
        )
        self.assertEqual(value["failed_owner"]["children"][0]["status"], "exited_failure")

    def test_rejects_stderr_only_as_api_start_failure(self):
        document = api_start_failure_probe(
            process_receipt={
                **api_start_failure_probe()["process_receipt"],
                "error": "private accepted-run reattach must succeed before API startup",
            }
        )
        with self.assertRaisesRegex(stop.BuildControlError, "API binding"):
            stop._validate_native_failure_probe(document, "a" * 64, api_start_failure=True)

    def test_api_start_failure_accepts_only_terminal_child_statuses(self):
        for status in ("exited_success", "exited_failure"):
            with self.subTest(status=status):
                document = api_start_failure_probe(
                    failed_owner=owner(compute_status=status)
                )
                stop._validate_native_failure_probe(
                    document, "a" * 64, api_start_failure=True
                )
        for status in ("running", "unknown"):
            with self.subTest(status=status):
                document = api_start_failure_probe(
                    failed_owner=owner(compute_status=status)
                )
                with self.assertRaises(stop.BuildControlError):
                    stop._validate_native_failure_probe(
                        document, "a" * 64, api_start_failure=True
                    )

    def test_pre_stop_cas_detects_owner_drift(self):
        first = api_start_failure_probe()
        changed = api_start_failure_probe(
            failed_owner={**first["failed_owner"], "owner_token": "other-owner"},
            failed_owner_sha256="d" * 64,
        )
        self.assertNotEqual(stop._native_failure_probe_cas(first), stop._native_failure_probe_cas(changed))

    def test_api_start_failure_blocks_unknown_process_and_resource_state(self):
        for changes in (
            {"owner_pid_exists": True},
            {"child_pids_exist": True},
            {"reservation_states": ["unknown"]},
            {"lease_states": ["unknown"]},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(stop.BuildControlError):
                    stop._validate_native_failure_probe(
                        api_start_failure_probe(**changes),
                        "a" * 64,
                        api_start_failure=True,
                    )

    def test_accepts_terminal_native_owner_with_drained_children(self):
        value = stop._validate_native_failure_probe(
            probe(), "a" * 64
        )
        self.assertEqual(value["failed_owner"]["state"], "failed")

    def test_rejects_failed_child_without_rewriting_evidence(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(
                probe(failed_owner=owner(compute_status="exited_failure")), "a" * 64
            )

    def test_rejects_live_child(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(
                probe(failed_owner=owner(compute_status="running")), "a" * 64
            )

    def test_rejects_active_lease_without_touching_history(self):
        document = probe(lease_states=["released", "active"])
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(document, "a" * 64)

    def test_rejects_receipt_that_can_still_drain_an_owner(self):
        document = probe(
            process_receipt={
                **probe()["process_receipt"],
                "service_owner": owner(),
            }
        )
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(document, "a" * 64)

    def test_rejects_digest_mismatch(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(probe(), "x" * 64)

    def test_native_failure_requires_positive_api_pid(self):
        for value in (None, False, 0, "3227"):
            with self.subTest(api_pid=value):
                document = probe()
                document["process_receipt"] = {
                    **document["process_receipt"],
                    "api_pid": value,
                }
                with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
                    stop._validate_native_failure_probe(document, "a" * 64)

        document = probe()
        document["process_receipt"] = {
            key: value for key, value in document["process_receipt"].items()
            if key != "api_pid"
        }
        with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
            stop._validate_native_failure_probe(document, "a" * 64)

    def test_accepts_after_ready_failure_with_failed_compute_child(self):
        value = stop._validate_native_after_ready_failure_probe(
            after_ready_probe(), "a" * 64
        )
        self.assertEqual(value["failed_owner"]["state"], "failed")
        self.assertEqual(value["ready_owner"]["state"], "ready")

    def test_after_ready_owner_is_identity_pinned(self):
        altered = after_ready_probe()
        altered["failed_owner"] = {**altered["failed_owner"], "owner_token": "other"}
        with self.assertRaisesRegex(stop.BuildControlError, "differs from retained ready"):
            stop._validate_native_after_ready_failure_probe(altered, "a" * 64)

    def test_after_ready_child_identity_is_pinned(self):
        altered = after_ready_probe()
        failed_owner = altered["failed_owner"]
        altered["failed_owner"] = {
            **failed_owner,
            "children": [
                {**failed_owner["children"][0], "pid": 9999},
                failed_owner["children"][1],
            ],
        }
        with self.assertRaisesRegex(stop.BuildControlError, "differs from retained ready"):
            stop._validate_native_after_ready_failure_probe(altered, "a" * 64)

    def test_after_ready_rejects_live_native_child(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(child_pids_exist=True), "a" * 64
            )

    def test_after_ready_rejects_live_native_worker(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(native_processes_live=True), "a" * 64
            )

    def test_after_ready_requires_positive_api_pid(self):
        for value in (None, False, 0, "3227"):
            with self.subTest(api_pid=value):
                document = after_ready_probe()
                document["process_receipt"] = {
                    **document["process_receipt"],
                    "api_pid": value,
                }
                with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
                    stop._validate_native_after_ready_failure_probe(document, "a" * 64)

        document = after_ready_probe()
        document["process_receipt"] = {
            key: value for key, value in document["process_receipt"].items()
            if key != "api_pid"
        }
        with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
            stop._validate_native_after_ready_failure_probe(document, "a" * 64)

    def test_after_ready_rejects_active_host_ledger(self):
        with self.assertRaisesRegex(stop.BuildControlError, "host ledger"):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(reservation_states=["active"]), "a" * 64
            )

    def test_after_ready_requires_integer_zero_lease_count(self):
        with self.assertRaisesRegex(stop.BuildControlError, "active durable resource lease"):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(active_lease_count=False), "a" * 64
            )

    def test_after_ready_requires_retained_ready_owner(self):
        document = after_ready_probe()
        document["process_receipt"] = {
            key: value for key, value in document["process_receipt"].items()
            if key != "service_owner"
        }
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_after_ready_failure_probe(document, "a" * 64)

    def test_probe_uses_canonical_receipt_and_scans_both_lease_roots(self):
        script = stop._native_failure_probe_script()
        self.assertIn(stop.CANONICAL_PROCESS_RECEIPT, script)
        self.assertIn("runtime_service.process_receipt_path(paths)", script)
        self.assertIn("resource_leases", script)
        self.assertIn("preparation_resource_leases", script)
        self.assertIn("OWNER.json", script)
        self.assertIn("NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA", stop.__dict__)
        self.assertIn("owner_pid_exists", script)
        self.assertIn("API_START_FAILURE_ERROR_PREFIX", script)
        self.assertIn("failure_mode", script)
        self.assertNotIn("FULLMAG_ACCEPTED_REATTACH_REQUEST", script)
        self.assertIn("package_root=pathlib.Path('/opt/fullmag/package')", script)
        self.assertIn("relative=pathlib.Path(executable).relative_to(package_root)", script)
        self.assertIn("executable_name == 'fullmag'", script)
        self.assertIn("executable_name.startswith('fullmag-')", script)
        self.assertIn("runtime_service.UUID_RE", script)
        self.assertNotIn("validation_owner={**owner", script)

    def test_native_process_scanner_detects_versioned_package_executables(self):
        entries = [
            SimpleNamespace(name="101", path="/proc/101"),
            SimpleNamespace(name="102", path="/proc/102"),
            SimpleNamespace(name="103", path="/proc/103"),
            SimpleNamespace(name="104", path="/proc/104"),
        ]
        executables = {
            "/proc/101/exe": "/opt/fullmag/package/bin/fullmag",
            "/proc/102/exe": "/opt/fullmag/package/current/bin/fullmag-api",
            "/proc/103/exe": "/opt/fullmag/package/generations/g/bin/fullmag-worker",
            "/proc/104/exe": "/usr/bin/python3",
        }
        os_mock = Mock()
        os_mock.scandir.return_value = entries
        os_mock.readlink.side_effect = executables.__getitem__

        self.assertEqual(self._extract_native_processes_live(os_mock)(), [101, 102, 103])

    def test_native_process_scanner_fails_closed_on_permission_errors(self):
        os_mock = Mock()
        os_mock.scandir.side_effect = PermissionError("proc denied")
        with self.assertRaisesRegex(RuntimeError, "cannot enumerate private process namespace"):
            self._extract_native_processes_live(os_mock)()

        os_mock = Mock()
        os_mock.scandir.return_value = [SimpleNamespace(name="101", path="/proc/101")]
        os_mock.readlink.side_effect = PermissionError("exe denied")
        with self.assertRaisesRegex(RuntimeError, "cannot inspect private process namespace"):
            self._extract_native_processes_live(os_mock)()



class RuntimeSupervisionProbeTests(unittest.TestCase):
    def setUp(self):
        import tempfile, types, os, json, copy, hashlib
        from unittest.mock import patch
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.state=self.root/'state';self.store=self.state/'runs/docker-all/session-store'
        self.native=self.root/'runtime-services';self.ledger=self.root/'ledger';self.receipt=self.root/'process-tree.json'
        for p in (self.native,self.ledger,self.store/'runs',self.store/'temp',self.store/'recovery'):p.mkdir(parents=True,exist_ok=True)
        for p in (self.native/'OWNER.lock',self.ledger/'WRITER.lock',self.store/'WRITER.lock'):p.touch()
        self.pin=owner();self.pin.update(state='ready',owner_token='11111111-1111-4111-8111-111111111111',process_start_token='22222222-2222-4222-8222-222222222222')
        for row in self.pin['children']:row['status']='running'
        self.failed=copy.deepcopy(self.pin);self.failed.update(state='failed',heartbeat_at='2026-10-19T10:00:02Z')
        for row in self.failed['children']:row['status']='exited_failure' if row['role']=='preparation' else 'exited_success'
        self.process={'schema':'fullmag.docker-process-tree.v1','state':'failed_outcome_retained','error':stop.SUPERVISION_FAILURE_ERROR,'api_pid':3227,'api_exit_code':-15,'accepted_store':str(self.store),'service_owner':self.pin}
        self.host={'schema':'fullmag.windows-folder-host.v1','storage_profile':'windows-folder-v1','restart_verified':True,'owner_token':'33333333-3333-4333-8333-333333333333','host_volume_serial':42,'host_root':r'D:\git\storage\runtime','engine_id':'fixture-engine'}
        self.cert=self.root/'certificate.json';self.config=self.root/'config.json';self.write(self.cert,self.host);self.write(self.config,{'fixture':True})
        self.write(self.state/'.fullmag-windows-folder-owner.json',self.host)
        self.write(self.state/'.fullmag-windows-folder-grant.json',{'schema':'fullmag.windows-folder-session.v1','state':'operational','container_root':'/state','host_attestation_sha256':hashlib.sha256(self.cert.read_bytes()).hexdigest(),'owner_token':self.host['owner_token']})
        self.rows=[];self.live=set()
        runtime_path=Path(__file__).resolve().parents[1]/'docker/all-in-one/runtime_service.py'
        spec=importlib.util.spec_from_file_location('runtime_service',runtime_path);runtime=importlib.util.module_from_spec(spec);sys.modules['runtime_service']=runtime;spec.loader.exec_module(runtime)
        paths=types.SimpleNamespace(state=self.state,store=self.store,host_certificate=self.cert,config=self.config)
        for name,value in [('canonical_paths',lambda:paths),('process_receipt_path',lambda p:self.receipt),('runtime_services_root',lambda p:self.native)]:
            p=patch.object(runtime,name,value);p.start();self.addCleanup(p.stop)
        self.environment={'FULLMAG_RUNS_ROOT':str(self.store.parent),'FULLMAG_STARTUP_ENABLED':'0'}
    def write(self,path,value):
        import json
        path.write_text(json.dumps(value,sort_keys=True))
    def execute(self):
        import json, os, contextlib, io
        from unittest.mock import patch
        self.write(self.receipt,self.process);self.write(self.native/'OWNER.json',self.failed);self.write(self.ledger/'HOST_RESOURCE_LEDGER.json',{'reservations':self.rows})
        script=stop._runtime_supervision_probe_script().replace(stop.CANONICAL_PROCESS_RECEIPT,str(self.receipt)).replace(stop.CANONICAL_HOST_LEDGER_ROOT,str(self.ledger))
        original=os.path.exists
        def exists(path):return int(str(path)[6:]) in self.live if str(path).startswith('/proc/') else original(path)
        output=io.StringIO()
        with patch.dict(os.environ,self.environment,clear=True),patch.object(os.path,'exists',side_effect=exists),contextlib.redirect_stdout(output):exec(compile(script,'<supervision-probe>','exec'),{})
        result=json.loads(output.getvalue());self.assertNotIn(self.host['owner_token'],output.getvalue());self.assertNotIn(self.pin['owner_token'],output.getvalue())
        return result
    def test_exact_failed_owner_and_empty_store_produce_only_redacted_proof(self):
        import hashlib
        result=self.execute();stop._validate_supervision_probe(result,hashlib.sha256(self.receipt.read_bytes()).hexdigest())
        self.assertTrue(result['processes_absent']);self.assertEqual(result['terminal_children'][1]['status'],'exited_failure')
    def test_foreign_reservation_is_preserved_and_allowed(self):
        self.rows=[{'identity':{'store_id':'sha256:'+'f'*64},'state':'active'}];before=list(self.rows);self.execute();self.assertEqual(self.rows,before)
    def test_own_windows_store_reservation_refuses(self):
        # Derive the independent Rust v2 normalization, including single backslashes.
        import hashlib,json
        identity={'schema':'fullmag.docker-admitted-store-identity.v2','host_root':self.host['host_root'].replace(chr(92),'/').lower(),'host_volume_serial':42,'engine_id':'fixture-engine','owner_token':self.host['owner_token'],'relative_state_path':'runs/docker-all/session-store'}
        self.rows=[{'identity':{'store_id':'sha256:'+hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()},'state':'active'}]
        with self.assertRaisesRegex(RuntimeError,'host reservation'):self.execute()
    def test_unknown_reservation_owner_refuses(self):
        self.rows=[{'state':'active'}]
        with self.assertRaisesRegex(RuntimeError,'ownership is unknown'):self.execute()
    def test_live_pid_refuses(self):
        for pid in (3227,3241,3250,3251):
            with self.subTest(pid=pid):
                self.live={pid}
                with self.assertRaisesRegex(RuntimeError,'live or ambiguous'):self.execute()
    def test_identity_change_refuses(self):
        self.failed['process_start_token']='44444444-4444-4444-8444-444444444444'
        with self.assertRaisesRegex(RuntimeError,'identity differs'):self.execute()
    def test_child_pid_change_refuses(self):
        self.failed['children'][0]['pid']=9999
        with self.assertRaisesRegex(RuntimeError,'children differ'):self.execute()
    def test_nonterminal_child_refuses(self):
        self.failed['children'][0]['status']='running'
        with self.assertRaisesRegex(RuntimeError,'failed-child'):self.execute()
    def test_all_success_is_not_the_supported_failure(self):
        self.failed['children'][1]['status']='exited_success'
        with self.assertRaisesRegex(RuntimeError,'failed-child'):self.execute()
    def test_accepted_or_pending_store_entries_refuse(self):
        for name in ('runs','temp','recovery'):
            p=self.store/name/'unexpected';p.touch()
            with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'pending transactions'):self.execute()
            p.unlink()
    def test_store_symlink_refuses(self):
        path=self.store/'runs';path.rmdir();path.symlink_to(self.root,target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,'unsafe accepted'):self.execute()
    def test_wrong_error_or_unbound_pin_refuses(self):
        self.process['error']='some other failure'
        with self.assertRaisesRegex(RuntimeError,'supported retained'):self.execute()
    def test_bad_windows_grant_refuses(self):
        self.write(self.state/'.fullmag-windows-folder-grant.json',{'state':'operational'})
        with self.assertRaisesRegex(RuntimeError,'Windows owner'):self.execute()
    def test_probe_flags_and_pid_types_fail_closed(self):
        result=self.execute()
        for key,value in [('processes_absent',False),('runs_empty',1),('runtime_pid',True),('failed_owner_sha256','z'*64)]:
            with self.subTest(key=key),self.assertRaises(stop.BuildControlError):stop._validate_supervision_probe(dict(result,**{key:value}),result['process_receipt_sha256'])



    def test_unknown_child_or_proof_fields_refuse_without_logging(self):
        self.failed['children'][0]['secret_extension']='fixture-secret'
        with self.assertRaisesRegex(RuntimeError,'failed-child'):self.execute()
        self.failed['children'][0].pop('secret_extension');result=self.execute()
        with self.assertRaisesRegex(stop.BuildControlError,'unexpected fields'):stop._validate_supervision_probe(dict(result,secret_extension='fixture-secret'),result['process_receipt_sha256'])
        result['terminal_children'][0]['secret_extension']='fixture-secret'
        with self.assertRaises(stop.BuildControlError):stop._validate_supervision_probe(result,result['process_receipt_sha256'])


    def test_actual_native_nanosecond_heartbeat_values(self):
        self.pin['heartbeat_at']='2026-10-20T04:44:35.242816163Z';self.failed['heartbeat_at']='2026-10-20T04:44:35.835081284Z';self.execute()
    def test_submicrosecond_order_and_exact_ties(self):
        for ready,failed in [('2026-10-20T04:44:35.835081283Z','2026-10-20T04:44:35.835081284Z'),('2026-10-20T04:44:35.835081284Z','2026-10-20T04:44:35.835081284Z'),('2026-10-20T04:44:35.1Z','2026-10-20T04:44:35.100000000Z'),('2026-10-20T04:44:35Z','2026-10-20T04:44:35.000000000Z'),('2026-10-20T04:44:35.999999999Z','2026-10-20T04:44:36Z')]:
            with self.subTest(ready=ready,failed=failed):self.pin['heartbeat_at']=ready;self.failed['heartbeat_at']=failed;self.execute()
    def test_nanosecond_reverse_order_refuses(self):
        self.pin['heartbeat_at']='2026-10-20T04:44:35.835081284Z';self.failed['heartbeat_at']='2026-10-20T04:44:35.835081283Z'
        with self.assertRaisesRegex(RuntimeError,'predates ready pin'):self.execute()
    def test_malformed_non_utc_and_overprecision_heartbeat_refuse(self):
        for value in ('2026-10-20T04:44:35.1234567890Z','2026-10-20T04:44:35.Z','2026-10-20T04:44:35+00:00','2026-10-20T04:44:35.1+01:00','2026-10-20 04:44:35Z','2026-02-30T04:44:35Z','2026-10-20T24:44:35Z','2026-10-20T04:44:35Zjunk',None):
            with self.subTest(value=value):
                self.failed['heartbeat_at']=value
                with self.assertRaises((RuntimeError,ValueError)):self.execute()


class SupervisionStopOperationTests(unittest.TestCase):
    def run_stop(self,fault=None):
        import docker_build_control as build, docker_volume_dev as dev, docker_volume_reconcile as reconcile
        import types,io,json,copy,hashlib,contextlib
        from unittest.mock import Mock,patch
        ids={'backend':'b'*64,'frontend':'f'*64};image='sha256:'+'a'*64;source=Path('D:/fixture');document={'fixture':'compose'}
        config=hashlib.sha256(build.canonical(document)).hexdigest()
        previous={'state':'succeeded','attempt':'1'*32,'compose_project':'fixture','config_sha256':config,'inputs':{'source_root':str(source)},'backend_container':ids['backend'],'frontend_container':ids['frontend']}
        proof={'schema':stop.SUPERVISION_FAILURE_SCHEMA,'process_receipt_sha256':'d'*64,'ready_pin_sha256':'e'*64,'failed_owner_sha256':'f'*64,'config_sha256':'c'*64,'windows_certificate_sha256':'a'*64,'accepted_store_id':'sha256:'+'2'*64,'api_pid':3227,'runtime_pid':3241,'terminal_children':[{'role':'compute','pid':3250,'status':'exited_success'},{'role':'preparation','pid':3251,'status':'exited_failure'}],'processes_absent':True,'runs_empty':True,'transients_empty':True,'affected_reservations_empty':True}
        services={name:{'Id':identifier,'Image':image,'State':{'StartedAt':'fixed-'+name,'Running':True,'Pid':100,'ExitCode':0}} for name,identifier in ids.items()}
        writes=[];stops=[];logger=Mock();logger.stdin=io.BytesIO();logger.wait.return_value=0
        control=types.SimpleNamespace(project='fixture',volume='fixture-control',namespace=None)
        control.path=lambda x:'/control/'+x;control.helper_args=lambda *a,**kw:['mock-helper'];control.space=lambda:{'available_bytes':100*1024**3};control._line=Mock(side_effect=['READY','LOGGED'])
        def read(path,optional=False):
            if path=='development/current.json' or path.endswith('/terminal.json'):return previous
            if path.endswith('/compose.json'):return document
            if optional:return None
            raise AssertionError(path)
        def write(path,value):
            if fault=='journal-write' and path.startswith('verification/') and value.get('state')=='stopped-confirmed':raise OSError('injected final journal write')
            writes.append((path,copy.deepcopy(value)))
        control.read=read;control.write=write;control.operation=types.MethodType(build.BuildControl.operation,control);control.operation_script=types.MethodType(build.BuildControl.operation_script,control)
        def docker(*args,**kwargs):
            if args[:2]==('image','inspect'):return types.SimpleNamespace(stdout=b'[{"Config":{}}]')
            if args[0]=='inspect':return types.SimpleNamespace(stdout=json.dumps([services[next(name for name,value in ids.items() if value==args[1])]]).encode())
            if args[0]=='exec':return types.SimpleNamespace(stdout=json.dumps(proof).encode())
            if args[0]=='stop':
                stops.append(args)
                if fault=='stop-unknown':raise build.ControlOutcomeUnknown('injected daemon transport unknown')
                services['backend']['State'].update(Running=False,Pid=0)
                if fault=='post-stop-live':services['backend']['State']['Pid']=7
                return types.SimpleNamespace(stdout=b'')
            raise AssertionError(args)
        terminal=Mock(return_value='7'*64)
        if fault=='terminal-unknown':terminal.side_effect=build.BuildControlError('injected terminal refusal')
        args=types.SimpleNamespace(container_id=ids['backend'],image_id=image,process_receipt_sha256='d'*64)
        error=None
        with patch.object(stop,'BuildControl',return_value=control),patch.object(build,'toolchain_configuration',return_value={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':'fixture-image'}}}}}),patch.object(stop,'docker_capture',side_effect=docker),patch.object(reconcile,'fingerprint',side_effect=lambda v:v['Id']),patch.object(dev,'_validate_retained_service'),patch.object(dev,'_assert_private_restart_network'),patch.object(dev,'_read_runtime_config_digest',return_value='c'*64),patch.object(stop,'_supervision_terminal_proof',terminal),patch.object(build.subprocess,'Popen',return_value=logger),contextlib.redirect_stdout(io.StringIO()):
            try:stop._stop_runtime_supervision_failure(args,source,{},copy.deepcopy(services['backend']))
            except Exception as caught:error=caught
        return writes,stops,logger,error
    def test_success_publishes_only_after_stopped_and_terminal_proof(self):
        writes,stops,logger,error=self.run_stop();self.assertIsNone(error);self.assertEqual(stops,[('stop','--time','60','b'*64)])
        journal=next(value for path,value in reversed(writes) if path.startswith('verification/'));self.assertEqual(journal['state'],'stopped-confirmed');self.assertNotIn('owner_token',str(journal));self.assertNotIn('service_owner',str(journal));self.assertTrue(any(path.endswith('/terminal.json') and value['state']=='succeeded' for path,value in writes));logger.wait.assert_called_once()
    def test_unknown_or_post_stop_failure_retains_real_control_lease(self):
        for fault in ('stop-unknown','post-stop-live','terminal-unknown','journal-write'):
            with self.subTest(fault=fault):
                writes,stops,logger,error=self.run_stop(fault);self.assertIsNotNone(error);self.assertEqual(len(stops),1)
                receipts=[v for p,v in writes if p.endswith('/receipt.json')];self.assertEqual(receipts[-1]['state'],'outcome-unknown-resources-retained');self.assertFalse(any(p.endswith('/terminal.json') for p,v in writes));logger.wait.assert_not_called()


if __name__ == "__main__":
    unittest.main()
