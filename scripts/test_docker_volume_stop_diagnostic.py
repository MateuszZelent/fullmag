"""Diagnostic stop preserves Unknown and authenticates the original Ready identity."""
import ast
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import docker_volume_stop_diagnostic as stop
from docker_build_control import BuildControlError
from test_docker_volume_stop_failed import ready_owner


class DiagnosticUnknownStopTests(unittest.TestCase):
    def test_pending_cgroup_stop_proof_rejects_active_owner_and_foreign_request(self):
        from types import SimpleNamespace
        backend={'Id':'b'*64,'Image':'image','Config':{'Labels':{'com.docker.compose.project':'project'}}}
        before={'failed_owner':{'state':'failed'},'probe':{'process_ids':[1,7,99,101]},
                'process_receipt':{'api_pid':99}}
        request={'container_id':'b'*64,'compose_project':'project','pid':7,'nonce':'a'*32}
        ready={'container_id':'b'*64,'compose_project':'project','image_id':'image'}
        proof={'request':request,'stale_ready':ready,'catalogs':{},'cgroup_not_ready':True}
        with patch.object(stop,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps(proof).encode())):
            self.assertEqual(stop._failed_iteration_runtime_probe(backend,before),proof)
            for state in ('ready','unknown'):
                with self.subTest(state=state),self.assertRaises(BuildControlError):
                    stop._failed_iteration_runtime_probe(backend,{**before,'failed_owner':{'state':state}})
        for change in ({'container_id':'foreign'},{'pid':99},{'nonce':'invalid'}):
            invalid={**proof,'request':{**request,**change}}
            with patch.object(stop,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps(invalid).encode())):
                with self.assertRaises(BuildControlError):stop._failed_iteration_runtime_probe(backend,before)

    def test_failed_iteration_requires_exact_receipt_and_frontend_enospc(self):
        from types import SimpleNamespace
        import hashlib
        control=SimpleNamespace(project='project',volume='volume',namespace='ns')
        previous={'inputs':{'source_root':'/source','image_id':'sha256:'+'1'*64},
                  'state_root':'/state','backend_container':'b'*64,'frontend_container':'f'*64,
                  'control_namespace':'ns'}
        receipt={'schema':'fullmag.docker-build-operation.v1','phase':'iteration',
                 'state':'failed-confirmed','attempt':'a'*32,'compose_project':'project',
                 'control_volume':'volume','control_namespace':'ns','config_sha256':'c'*64,
                 'inputs':{'attempt':'d'*32,'config_sha256':'c'*64,**previous['inputs']},
                 'state_root':'/state','backend_container':'b'*64,'frontend_container':'f'*64,
                 'backend_started_at':'current','frontend_started_at':'front-current',
                 'error':"linux_native_probe.py\nOSError: [Errno 28] No space left on device: '/state/.linux-native-probe-test'"}
        def validate(r,sha=None):
            raw=json.dumps(r).encode()
            with patch.object(stop,'_read_raw',return_value=raw):
                return stop._validate_failed_iteration_terminal(control,'a'*32,
                    sha or hashlib.sha256(raw).hexdigest(),development_attempt='d'*32,
                    config_sha256='c'*64,previous=previous)
        self.assertEqual(validate(receipt)['backend_started_at'],'current')
        for field,value in [('state','succeeded'),('backend_container','other'),
                            ('control_namespace','foreign'),('error','backend build failed')]:
            with self.subTest(field=field),self.assertRaises(BuildControlError):
                validate({**receipt,field:value})
        with self.assertRaises(BuildControlError):validate(receipt,'0'*64)

    def fixture(self):
        ready=ready_owner()
        owner={**ready,'state':'unknown','heartbeat_at':'2026-10-25T14:00:00Z',
               'children':[{**c,'status':'exited_failure' if c['role']=='preparation' else 'running'} for c in ready['children']]}
        fence_path=stop.FENCE_PARENT+'/api-failure-'+'1'*32+'.json'
        process={'schema':'fullmag.docker-process-tree.v1','state':'failed_outcome_retained',
                 'api_pid':500,'api_diagnostic_only':True,'api_failure_fence':fence_path,'runtime_pid':None,
                 'service_owner':ready,'error':'runtime service owner observation failed during supervision: runtime service owner is not ready'}
        return owner,process

    def evidence(self,owner,process):
        config={'schema_version':'runtime_service_config.v2','target_id':'docker-all',
                'store_root':'/state/runs/docker-all/session-store'}
        fence={'schema':'fullmag.api-runtime-failure-fence.v1','stage':'runtime_supervision',
               'api_pid':process['api_pid'],'api_instance_id':'instance'}
        values={'runtime_config':config,'owner':owner,'process_receipt':process,'failure_fence':fence}
        raw={k:json.dumps(v,sort_keys=True).encode() for k,v in values.items()}
        paths={'runtime-control/runtime-service/docker-all.json':raw['runtime_config'],
               'runtime-control/runtime-services/OWNER.json':raw['owner'],
               'runtime-control/runtime-service/process-tree.json':raw['process_receipt'],
               stop._runtime_relative(process['api_failure_fence']):raw['failure_fence']}
        probe={k:base64.b64encode(v).decode() for k,v in raw.items()}
        probe.update(api_failure_fence=process['api_failure_fence'],api_instance_id='instance')
        with patch.object(stop,'_read_raw',side_effect=lambda control,path,**kw:paths[path]), \
             patch('docker_volume_unclaimed_cancellation._control_raw',return_value=None):
            return stop._probe_evidence(object(),'development/attempts/'+'a'*32,probe)

    def test_host_check_keeps_unknown_and_original_ready_bytes(self):
        owner,process=self.fixture();before=copy.deepcopy((owner,process))
        result=self.evidence(owner,process)
        self.assertEqual(result['failed_owner'],owner)
        self.assertEqual(result['failed_owner']['state'],'unknown')
        self.assertEqual(result['ready_owner'],process['service_owner'])
        self.assertEqual((owner,process),before)

    def test_drift_or_unfenced_api_is_refused(self):
        for field,value in [('owner_token','other'),('pid',999),('state','ready')]:
            owner,process=self.fixture();owner[field]=value
            with self.subTest(field=field),self.assertRaises(BuildControlError):self.evidence(owner,process)
        for field,value in [('api_diagnostic_only',False),('runtime_pid',123),('api_exit_code',0),('error','different')]:
            owner,process=self.fixture();process[field]=value
            with self.subTest(field=field),self.assertRaises(BuildControlError):self.evidence(owner,process)

    def test_preview_helper_must_hold_its_exact_phase_lease(self):
        from types import SimpleNamespace
        attempt='a'*32;helper_id='b'*64
        ids={'backend':'c'*64,'frontend':'d'*64}
        control=SimpleNamespace(image='image',project='project',volume='volume',identity={})
        for preview, startup in [(True,False),(False,False),(True,True),(False,True)]:
            prefix='startup-recovery-stop' if startup else 'stop-diagnostic'
            phase=prefix+('-preview' if preview else '')
            operation={'receipt':{'attempt':attempt,'helper_container':'fullmag-control-'+attempt,
                                 'phase':phase,'inputs':{'preview_only':preview,'startup_recovery':startup}}}
            helper={'Id':helper_id,'Config':{'Image':'image','Labels':{
                'com.docker.compose.project':'project','com.docker.compose.service':'build-control',
                'org.fullmag.compose.project':'project'},'Cmd':['/control/'+phase+'/attempts/'+attempt+' until test -f /control/active']},
                'State':{'Running':True},'HostConfig':{'NetworkMode':'none'},
                'Mounts':[{'Destination':'/control','Type':'volume','Name':'volume'}]}
            expected=set(ids.values())|{helper_id}
            with patch.object(stop,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps([helper]).encode())), \
                 patch('docker_compose_identity.validate_source_labels'), \
                 patch('docker_volume_unclaimed_cancellation._project_container_ids',return_value=expected), \
                 patch('docker_volume_unclaimed_cancellation._volume_consumer_ids',return_value=expected):
                self.assertEqual(stop._assert_group_consumers(control,operation,ids),helper_id)
                operation['receipt']['inputs']['preview_only']=not preview
                with self.assertRaises(BuildControlError):stop._assert_group_consumers(control,operation,ids)

    def test_serialized_guest_uses_the_same_identity_check(self):
        tree=ast.parse(stop._probe_script())
        branch=next(n for n in tree.body if isinstance(n,ast.If) and "owner.get('state') == 'unknown'" in ast.unparse(n.test))
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'require','validate_diagnostic_build'}]
        module=ast.fix_missing_locations(ast.Module(body=[*functions,branch],type_ignores=[]))
        owner,process=self.fixture();scope={'owner':owner,'process':process}
        exec(compile(module,'guest-owner-check','exec'),scope)
        self.assertEqual(owner['state'],'unknown')
        scope['owner']={**owner,'owner_token':'other'}
        with self.assertRaises(ValueError):exec(compile(module,'guest-owner-check','exec'),scope)


class StartupRecoveryDiagnosticStopTests(unittest.TestCase):
    def fixture(self):
        from types import SimpleNamespace

        owner = ready_owner()
        image = "sha256:" + "1" * 64
        backend_id, frontend_id = "b" * 64, "f" * 64
        backend_started = "2026-11-07T08:00:00.000000000Z"
        frontend_started = "2026-11-07T08:01:00.000000000Z"
        project, source = "fullmag-worktree-test", "/checkout"
        attempt, config_sha = "a" * 32, "c" * 64
        cgroup = {"schema": "fullmag.worker-cgroup-ready.v1", "state": "ready",
                  "compose_project": project, "container_id": backend_id, "image_id": image,
                  "root": "/opt/fullmag/worker-cgroup", "nonce": "d" * 32,
                  "pid": 7, "process_start_token": "1:2", "boot_id": "boot",
                  "backend_init_pid": 1007, "backend_init_start_token": "9:8",
                  "container_cgroup": "/docker/" + backend_id,
                  "container_cgroup_device": 12, "container_cgroup_inode": 100,
                  "root_device": 12, "root_inode": 101, "controllers": ["cpu"],
                  "subtree_control": ["cpu"], "outer_limits": {"cpu.max": "max 100000",
                  "memory.max": "max"}, "delegated_uid": 65532, "delegated_gid": 65532}
        previous = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "failed-confirmed", "attempt": attempt, "compose_project": project,
            "control_volume": "control-volume", "config_sha256": config_sha,
            "state_root": "/state", "backend_container": backend_id,
            "frontend_container": frontend_id, "backend_started_at": backend_started,
            "frontend_started_at": frontend_started, "worker_cgroup": cgroup,
            "inputs": {"source_root": source, "image_id": image},
        }
        actual = {
            "backend": {"Id": backend_id, "Image": image,
                        "State": {"Running": True, "StartedAt": backend_started}},
            "frontend": {"Id": frontend_id, "Image": image,
                         "State": {"Running": True, "StartedAt": frontend_started}},
        }
        config = {"schema_version": "runtime_service_config.v2", "target_id": "docker-all",
                  "store_root": "/state/runs/docker-all/session-store"}
        launch = {"schema_version": "runtime_service_launch.v1", "state": "ready", "pid": 18737}
        process = {"schema": "fullmag.docker-process-tree.v1", "state": "shutdown_unknown",
                   "api_pid": 18837, "api_exit_code": -15,
                   "api_failure_fence": "/opt/fullmag/runtime-control/runtime-service/api-failure-" + "9" * 32 + ".json"}
        instance = "11111111-2222-4333-8444-555555555555"
        fence_path = "/opt/fullmag/runtime-control/runtime-service/api-failure-" + "8" * 32 + ".json"
        commit = "b700cc4081d5470f6e4defd0e545acecf91044d1"
        snapshot = "39c7ea7508d7febe4cd394427afbd18657988e0e3bed34fc5a77bb1ff4c33258"
        reason = ("runtime CLI failed: [fullmag] version: 0.1.0 | commit: " + commit + " | source snapshot: " + snapshot
                  + "\nError: unapplied terminal heartbeat requires a failed nonzero process-exit receipt")
        fence = {"schema": "fullmag.api-runtime-failure-fence.v1", "stage": "runtime_startup",
                 "reason": reason}
        provenance = {"commit": commit, "source_snapshot_sha256": snapshot,
                      "native_source_identity": {"source_snapshot_sha256": snapshot}}
        config_raw = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
        owner_raw = json.dumps(owner, sort_keys=True, separators=(",", ":")).encode()
        launch_raw = json.dumps(launch, sort_keys=True, separators=(",", ":")).encode()
        process_raw = json.dumps(process, sort_keys=True, separators=(",", ":")).encode()
        fence_raw = json.dumps(fence, sort_keys=True, separators=(",", ":")).encode()
        provenance_raw = json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode()
        auth = {"schema_version": "fullmag.docker-container-recovery-authorization.v1",
                "source_root": source, "compose_project": project,
                "config_sha256": hashlib.sha256(config_raw).hexdigest(),
                "owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
                "launch_sha256": hashlib.sha256(launch_raw).hexdigest(),
                "request_id": "22222222-3333-4444-8555-666666666666",
                "native_request_sha256": "2" * 64,
                "backend_container_id": backend_id, "frontend_container_id": frontend_id,
                "old_image_id": image, "operator_authorization_sha256": "3" * 64,
                "attestation_sha256": "4" * 64, "manifest_sha256": "5" * 64,
                "prior_stop_journal_sha256": "6" * 64,
                "native_request_path": "/opt/fullmag/control/runtime-control/container-recovery/request.json",
                "attestation_path": "/opt/fullmag/control/runtime-control/container-recovery/attestation.json",
                "manifest_path": "/opt/fullmag/control/runtime-control/container-recovery/manifest.json"}
        request = {"request_id": auth["request_id"], "config_sha256": auth["config_sha256"],
                   "schema_version": "runtime_service_container_recovery_request.v3",
                   "owner_sha256": auth["owner_sha256"], "launch_sha256": auth["launch_sha256"],
                   "expected_owner": owner,
                   "store_root_sha256": "3" * 64, "ledger_root_sha256": "4" * 64,
                   "ledger_snapshot_sha256": "5" * 64,
                   "retained_terminal_runs": [{"run_id": "run-test", "run_intent_sha256": "1" * 64,
                                               "run_catalog_sha256": "2" * 64, "artifact_catalog_sha256": None}],
                   "application": {"mode": "persisted", "raw_sha256": "8" * 64},
                   "prior_ready_owner_proof_sha256": "9" * 64,
                   "device_release_mapping_sha256": "a" * 64}
        storage_proof = {"store_root_sha256": request["store_root_sha256"],
                         "ledger_root_sha256": request["ledger_root_sha256"],
                         "ledger_snapshot_sha256": request["ledger_snapshot_sha256"],
                         "run_records": []}
        released = {"active_count": 0, "reservations": [], "leases": []}
        probe = {"schema": "fullmag.docker-startup-recovery-stop-probe.v1",
                 "runtime_config": base64.b64encode(config_raw).decode(),
                 "owner": base64.b64encode(owner_raw).decode(),
                 "launch": base64.b64encode(launch_raw).decode(),
                 "process_receipt": base64.b64encode(process_raw).decode(),
                 "failure_fence": base64.b64encode(fence_raw).decode(),
                 "provenance": base64.b64encode(provenance_raw).decode(),
                 "api_pid": 41, "api_instance_id": instance, "probe_pid": 99,
                 "api_failure_fence": fence_path, "process_ids": [1, 7, 41, 99],
                 "supervisor_pid": 7, "health_status": 200,
                 "health": {"status": "degraded", "active_session": False},
                 "health_instance_id": instance, "openapi_status": 200,
                 "build_identity": {"git_commit": provenance["commit"],
                                    "source_snapshot_sha256": provenance["source_snapshot_sha256"]},
                 "current_status": 503,
                 "current_status_body": {"code": "runtime_unavailable"},
                 "worker_cgroup": base64.b64encode(json.dumps(cgroup).encode()).decode(),
                 "worker_cgroup_request": base64.b64encode(json.dumps({
                     **{key: cgroup[key] for key in ("nonce", "compose_project", "pid",
                        "process_start_token", "boot_id", "container_id")},
                     "schema": "fullmag.worker-cgroup-request.v1"}).encode()).decode(),
                 "api_process": {"pid": 41, "ppid": 7, "start_ticks": "100", "exe": "/opt/fullmag/package/bin/fullmag-api"},
                 "supervisor_process": {"pid": 7, "ppid": 1, "start_ticks": "200", "exe": "/usr/local/bin/python3"},
                 "owner_pids_absent": sorted([owner["pid"], *[child["pid"] for child in owner["children"]]])}
        control = SimpleNamespace(project=project, volume="control-volume", namespace="")
        return {"control": control, "selected": Path(source), "attempt": attempt,
                "config_sha256": config_sha, "previous": previous, "actual": actual,
                "cgroup": cgroup, "auth": auth, "request": request,
                "probe": probe, "storage_proof": storage_proof,
                "released": released, "process_raw": process_raw,
                "owner_raw": owner_raw, "config_raw": config_raw,
                "fence_raw": fence_raw, "launch_raw": launch_raw,
                "provenance_raw": provenance_raw}

    def test_exact_failed_development_and_ready_cgroup_are_required(self):
        value = self.fixture()
        stop._validate_startup_recovery_development(
            value["control"], value["previous"], value["selected"],
            value["config_sha256"], value["actual"],
        )
        mutations = (
            lambda item: item["previous"].update(phase="resume"),
            lambda item: item["previous"].update(state="succeeded"),
            lambda item: item["previous"]["worker_cgroup"].update(state="starting"),
            lambda item: item["previous"]["worker_cgroup"].update(container_id="0" * 64),
            lambda item: item["actual"]["backend"]["State"].update(StartedAt="changed"),
            lambda item: item["previous"]["inputs"].update(source_root="/foreign"),
        )
        for mutate in mutations:
            item = self.fixture(); mutate(item)
            with self.subTest(previous=item["previous"], actual=item["actual"]), self.assertRaises(BuildControlError):
                stop._validate_startup_recovery_development(
                    item["control"], item["previous"], item["selected"],
                    item["config_sha256"], item["actual"],
                )

    def test_startup_fence_api_owner_auth_and_storage_must_all_match(self):
        value = self.fixture()
        stop._validate_startup_recovery_observation(
            value["probe"], value["auth"], value["request"], value["cgroup"],
            value["storage_proof"], value["released"],
        )
        mutations = (
            lambda item: item["probe"].__setitem__("api_pid", 42),
            lambda item: item["probe"].__setitem__("health_instance_id", "different"),
            lambda item: item["probe"].__setitem__("api_failure_fence", "/tmp/foreign.json"),
            lambda item: item["probe"].__setitem__("process_ids", [1, 7, 41, 99, 100]),
            lambda item: item["probe"].__setitem__("current_status_body", {"code": "other"}),
            lambda item: item["auth"].__setitem__("owner_sha256", "0" * 64),
            lambda item: item["storage_proof"].__setitem__("ledger_snapshot_sha256", "0" * 64),
            lambda item: item["released"].update(active_count=1),
        )
        for mutate in mutations:
            item = self.fixture(); mutate(item)
            with self.subTest(probe=item["probe"], released=item["released"]), self.assertRaises(BuildControlError):
                stop._validate_startup_recovery_observation(
                    item["probe"], item["auth"], item["request"], item["cgroup"],
                    item["storage_proof"], item["released"],
                )

    def test_historical_owner_and_process_tree_are_not_reclassified(self):
        value = self.fixture()
        process = json.loads(base64.b64decode(value["probe"]["process_receipt"]))
        process["state"] = "drained"
        value["probe"]["process_receipt"] = base64.b64encode(
            json.dumps(process, sort_keys=True, separators=(",", ":")).encode()
        ).decode()
        with self.assertRaises(BuildControlError):
            stop._validate_startup_recovery_observation(
                value["probe"], value["auth"], value["request"], value["cgroup"],
                value["storage_proof"], value["released"],
            )

    def test_completed_or_mismatched_native_recovery_receipt_is_rejected(self):
        value = self.fixture()
        receipt = {"schema_version": "runtime_service_container_recovery.v1",
                   "status": "prepared", "completed_at": None,
                   "request_id": value["request"]["request_id"],
                   "request_sha256": value["auth"]["native_request_sha256"],
                   "config_sha256": value["request"]["config_sha256"],
                   "owner_sha256_before": value["request"]["owner_sha256"],
                   "owner_state_before": "ready", "owner_state_after": "failed",
                   "store_root_sha256": value["request"]["store_root_sha256"],
                   "ledger_root_sha256": value["request"]["ledger_root_sha256"],
                   "ledger_snapshot_sha256": value["request"]["ledger_snapshot_sha256"],
                   "outcome": "retained_terminal_runs_recovered",
                   "target_id": "docker-all", "owner_sha256_after": "7" * 64,
                   "application": {"mode": "persisted", "raw_sha256": "8" * 64},
                   "attestation_sha256": value["auth"]["attestation_sha256"],
                   "docker_manifest_sha256": value["auth"]["manifest_sha256"],
                   "prior_ready_owner_proof_sha256": "9" * 64,
                   "device_release_mapping_sha256": "a" * 64,
                   "archived_evidence_path": "/state/runs/docker-all/session-store/runtime-services/container-recovery/archive/manifest.json",
                   "archived_evidence_sha256": "b" * 64,
                   "archived_files": {"runtime-services/OWNER.json": "c" * 64},
                   "archived_absent_sources": {},
                   "historical_build_commit": value["request"]["expected_owner"]["build_commit"],
                   "historical_build_snapshot": value["request"]["expected_owner"]["build_snapshot"],
                   "executor_build_commit": "f" * 40,
                   "executor_build_snapshot": "1" * 64,
                   "created_at": "2026-11-07T08:02:00Z"}
        stop._validate_startup_recovery_native_receipt(receipt, value["auth"], value["request"])
        for changed in ({**receipt, "status": "recovered", "completed_at": "now"},
                        {**receipt, "request_sha256": "0" * 64},
                        {**receipt, "owner_state_before": "failed"}):
            with self.subTest(receipt=changed), self.assertRaises(BuildControlError):
                stop._validate_startup_recovery_native_receipt(changed, value["auth"], value["request"])

    def test_repeatable_plan_ignores_only_probe_and_health_liveness(self):
        from types import SimpleNamespace

        value = self.fixture()
        ids = {role: row["Id"] for role, row in value["actual"].items()}
        for row in value["actual"].values():
            row["Mounts"] = []
            row["State"]["Health"] = {"Log": ["first observation"]}
            row["ExecIDs"] = ["transient-healthcheck"]
        authority = {"authorization": value["auth"], "request": value["request"],
                     "operator_authorization": {"process_receipt_sha256": hashlib.sha256(value["process_raw"]).hexdigest()},
                     "storage_proof": value["storage_proof"], "released_snapshot": value["released"],
                     "raw": {key: key.encode() for key in ("runtime_authorization", "operator_authorization",
                         "abrupt_proof", "native_request", "attestation", "manifest")}}
        authority["raw"]["prepared_receipt"] = None
        args = SimpleNamespace(attempt=value["attempt"], config_sha256=value["config_sha256"])
        control = value["control"]
        control.read_bytes = lambda path: path.encode()
        image = value["previous"]["inputs"]["image_id"]
        with patch.object(stop, "_container_snapshot", return_value=(image, ids, value["actual"])), \
             patch.object(stop, "_assert_startup_recovery_consumers", side_effect=["first-helper", "second-helper"]), \
             patch.object(stop, "_startup_recovery_authority", return_value=authority), \
             patch.object(stop, "_probe_startup_recovery_backend", return_value=value["probe"]), \
             patch.object(stop, "_read_raw", side_effect=lambda ctl, path: path.encode()):
            first = stop._capture_startup_recovery_plan(args, value["selected"], {}, control,
                value["previous"], "development/attempts/" + value["attempt"], {}, {})[0]
            value["probe"]["probe_pid"] = 100
            value["probe"]["process_ids"] = [1, 7, 41, 100]
            for row in value["actual"].values():
                row["State"]["Health"] = {"Log": ["second observation"]}
                row["ExecIDs"] = None
            second = stop._capture_startup_recovery_plan(args, value["selected"], {}, control,
                value["previous"], "development/attempts/" + value["attempt"], {}, {})[0]
        self.assertEqual(first, second)
        changed = copy.deepcopy(value["actual"]["backend"])
        changed["State"]["StartedAt"] = "replacement"
        self.assertNotEqual(stop._startup_recovery_container_pin(changed), first["backend"])

    def test_startup_dispatch_is_explicit(self):
        from types import SimpleNamespace

        with patch.object(stop, "_stop_startup_recovery_diagnostic", return_value={"state": "preview-passed"}) as run:
            self.assertEqual(stop.stop_diagnostic(SimpleNamespace(startup_recovery=True)), {"state": "preview-passed"})
            run.assert_called_once()
        with self.assertRaises(BuildControlError):
            stop.stop_diagnostic(SimpleNamespace(expected_plan_sha256="1" * 64))

    def test_serialized_startup_probe_compiles(self):
        source = stop._startup_recovery_probe_script(self.fixture()["cgroup"])
        compile(source, "startup-probe", "exec")
        self.assertIn("runtime_startup", source)
        self.assertIn("shutdown_unknown", source)
        self.assertIn("x-fullmag-api-instance", source)


class StartupStopReconciliationTests(unittest.TestCase):
    def run_reconciliation(self, drift=None):
        from types import SimpleNamespace

        value = StartupRecoveryDiagnosticStopTests().fixture()
        control = value["control"]
        attempt = "9" * 32
        root = "startup-recovery-stop/attempts/" + attempt
        previous_root = "development/attempts/" + value["attempt"]
        image = value["previous"]["inputs"]["image_id"]
        actual = copy.deepcopy(value["actual"])
        for row in actual.values():
            row["Mounts"] = []
        actual["backend"]["State"].update(Running=False, Pid=0, ExitCode=0, OOMKilled=False, FinishedAt="finished")
        ids = {role: row["Id"] for role, row in actual.items()}
        terminal_raw, compose_raw = stop.canonical(value["previous"]), b"{}"
        inputs = {"attempt": value["attempt"], "config_sha256": value["config_sha256"],
                  "source_root": str(value["selected"]), "startup_recovery": True, "preview_only": False,
                  "backend_container_id": ids["backend"], "frontend_container_id": ids["frontend"],
                  "backend_started_at": actual["backend"]["State"]["StartedAt"], "image_id": image,
                  "terminal_sha256": stop._sha256(terminal_raw), "compose_sha256": stop._sha256(compose_raw)}
        receipt = {"state": "outcome-unknown-resources-retained", "phase": "startup-recovery-stop",
                   "attempt": attempt, "compose_project": control.project, "control_volume": control.volume,
                   "error": "Frontend incarnation changed while stopping only the backend", "inputs": inputs,
                   "helper_container_id": "1" * 64}
        authority = {"storage_proof": value["storage_proof"], "released_snapshot": value["released"],
                     "raw": {key: key.encode() for key in ("runtime_authorization", "operator_authorization",
                         "abrupt_proof", "native_request", "attestation", "manifest")}}
        authority["raw"]["prepared_receipt"] = None
        files = {previous_root + "/terminal.json": terminal_raw, previous_root + "/compose.json": compose_raw}
        guest = {}
        for relative, key in {
            "runtime-control/runtime-services/OWNER.json": "owner_sha256",
            "runtime-control/runtime-services/LAUNCH.json": "launch_sha256",
            "runtime-control/runtime-service/docker-all.json": "runtime_config_sha256",
            "runtime-control/runtime-service/process-tree.json": "historical_process_receipt_sha256",
            "runtime-control/runtime-service/api-failure-" + "8" * 32 + ".json": "startup_failure_fence_sha256",
            "runtime-control/worker-cgroup/ready.json": "worker_cgroup_ready_sha256",
            "runtime-control/worker-cgroup/request.json": "worker_cgroup_request_sha256",
            "backend/runtime-provenance.json": "provenance_sha256",
        }.items():
            files[relative] = relative.encode()
            guest[key] = stop._sha256(files[relative])
        guest["api_failure_fence"] = "/opt/fullmag/runtime-control/runtime-service/api-failure-" + "8" * 32 + ".json"
        plan = {"frontend": actual["frontend"], "storage_proof": value["storage_proof"],
                "released_snapshot": value["released"], "guest_observation": guest, "prepared_receipt_sha256": None}
        for name, field in (("runtime_authorization", "recovery_authorization_sha256"),
                            ("operator_authorization", "operator_authorization_sha256"),
                            ("abrupt_proof", "abrupt_proof_sha256"), ("native_request", "native_request_sha256"),
                            ("attestation", "attestation_sha256"), ("manifest", "manifest_sha256")):
            plan[field] = stop._sha256(authority["raw"][name])
        plan_sha = stop._sha256(stop.canonical(plan))
        intent = {"schema": "fullmag.docker-startup-recovery-stop-intent.v1", "state": "stop-planned",
                  "plan_sha256": plan_sha, "backend_image_id": image,
                  **{key: inputs[key] for key in ("backend_container_id", "backend_started_at",
                     "frontend_container_id", "terminal_sha256", "compose_sha256")}}
        if drift == "intent":
            intent["backend_container_id"] = "0" * 64
        if drift == "source":
            files[previous_root + "/terminal.json"] += b" "
        if drift == "receipt":
            authority["raw"]["prepared_receipt"] = b"new prepared receipt"
        intent_path = "verification/startup-recovery-stop-intent-" + ids["backend"] + ".json"
        files[intent_path] = stop.canonical(intent)
        helper_files = {"active": (attempt + "\n").encode(), root + "/receipt.json": stop.canonical(receipt),
                        root + "/terminal.json": None, root + "/preflight.json": stop.canonical(plan)}
        args = SimpleNamespace(reconcile_startup_stop_attempt=attempt, attempt=value["attempt"],
                               expected_plan_sha256=plan_sha, config_sha256=value["config_sha256"])
        with patch("docker_volume_activation_reconcile._validate_helper", return_value=({}, "1" * 64)), \
             patch("docker_volume_activation_reconcile._validate_helper_logged"), \
             patch("docker_volume_activation_reconcile._wait_for_helper_exit"), \
             patch.object(stop, "_read_from_original_helper", side_effect=lambda ctl, helper, path, **kwargs: helper_files[path]), \
             patch.object(stop, "_read_raw", side_effect=lambda ctl, path: files[path]), \
             patch.object(stop, "_container_snapshot", return_value=(image, ids, actual)), \
             patch.object(stop, "_assert_startup_recovery_consumers"), \
             patch.object(stop, "_startup_recovery_authority", return_value=authority), \
             patch.object(stop, "docker_capture", side_effect=AssertionError("Reconciliation must never signal Docker")), \
             patch.object(stop, "_publish_helper_reconciliation") as publish:
            if drift is not None:
                with self.assertRaises(BuildControlError):
                    stop._reconcile_startup_stop(args, control, value["selected"], {})
                publish.assert_not_called()
                return
            result = stop._reconcile_startup_stop(args, control, value["selected"], {})
            self.assertEqual(result, {"state": "stopped-confirmed", "signals_sent": 0})
            publish.assert_called_once()
            proof = json.loads(publish.call_args.kwargs["proof_raw"])
            self.assertEqual(proof["signals_sent"], 0)
            self.assertEqual(receipt["state"], "outcome-unknown-resources-retained")

    def test_reconciliation_observes_without_another_signal(self):
        self.run_reconciliation()

    def test_reconciliation_refuses_source_intent_and_optional_receipt_drift(self):
        for drift in ("source", "intent", "receipt"):
            with self.subTest(drift=drift):
                self.run_reconciliation(drift)

    @unittest.skipUnless(Path("/bin/bash").is_file(), "requires the managed helper shell")
    def test_publisher_resumes_exact_proof_and_refuses_different_proof(self):
        import tempfile
        from types import SimpleNamespace

        for matching in (True, False):
            with self.subTest(matching=matching), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                root = "startup-recovery-stop/attempts/" + "9" * 32
                operation = folder / root
                operation.mkdir(parents=True)
                (folder / "active").write_bytes(b"active\n")
                (operation / "receipt.json").write_bytes(b"original receipt")
                proof = b'{"signals_sent":0}\n'
                (operation / "startup-stop-reconciliation-proof.json").write_bytes(proof if matching else b"different")
                control = SimpleNamespace(path=lambda relative: str(folder / relative),
                    _namespace_guard=lambda script: script.replace("sync /control;", "sync '" + directory + "';"))
                def shell(*argv, **kwargs):
                    self.assertEqual(argv[0], "exec")
                    return subprocess.run(["/bin/bash", "-euo", "pipefail", "-c", argv[-1]],
                                          capture_output=True, timeout=15)
                with patch.object(stop, "docker_capture", side_effect=shell):
                    kwargs = dict(root=root, active_sha256=stop._sha256(b"active\n"),
                                  receipt_sha256=stop._sha256(b"original receipt"), proof_raw=proof,
                                  terminal_raw=b'{"state":"succeeded"}\n',
                                  proof_name="startup-stop-reconciliation-proof.json")
                    if matching:
                        stop._publish_helper_reconciliation(control, "1" * 64, **kwargs)
                        self.assertEqual((operation / "terminal.json").read_bytes(), kwargs["terminal_raw"])
                    else:
                        with self.assertRaises(BuildControlError):
                            stop._publish_helper_reconciliation(control, "1" * 64, **kwargs)
                        self.assertFalse((operation / "terminal.json").exists())
                self.assertEqual((operation / "receipt.json").read_bytes(), b"original receipt")
                self.assertEqual((folder / "active").read_bytes(), b"active\n")


class DiagnosticStopShellTests(unittest.TestCase):
    def dispatch(self,extra='',resume=True,preview=True):
        source=(Path(__file__).parent/'just_storage_shell.sh').read_text()
        body=source.split('  *"scripts/docker_dev.py"*" stop-diagnostic-volume "*)\n',1)[1].split('\n    ;;',1)[0]
        recipe=('python "/ignored/scripts/docker_dev.py" --repo-root "/ignored" stop-diagnostic-volume '
                "--attempt '"+'a'*32+"' --config-sha256 '"+'b'*64+"' --source-root '/selected/worktree' --port '3203'")
        if resume:recipe+=" --resume-attempt '"+'c'*32+"'"
        if preview:recipe+=' --preview'
        recipe+=extra
        program=('set -euo pipefail\nrecipe="$RECIPE_LITERAL"\n'
                 'python_cmd="/recorded/python"\nscript_dir="/registered/scripts"\nrepo_root="/registered"\n'
                 'exec() { printf \'%s\\0\' "$@"; }\n'+body)
        return subprocess.run(['/bin/bash','--noprofile','--norc','-c',program],
            env={**os.environ,'RECIPE_LITERAL':recipe},capture_output=True,timeout=15)

    def test_exact_preview_and_mutation_argv(self):
        for preview in [True,False]:
            result=self.dispatch(preview=preview)
            self.assertEqual(result.returncode,0,result.stderr)
            argv=result.stdout.split(b'\0')[:-1]
            self.assertIn(b'stop-diagnostic-volume',argv)
            self.assertEqual(b'--preview' in argv,preview)
            self.assertEqual(argv[argv.index(b'--resume-attempt')+1],b'c'*32)
        result=self.dispatch(resume=False);self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn(b'--resume-attempt',result.stdout)

    def test_composite_or_unknown_arguments_are_refused(self):
        for extra in ['; printf injected',' && printf injected','\nprintf injected',' --force',' --preview']:
            result=self.dispatch(extra)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertFalse(result.stdout)


if __name__=='__main__':unittest.main()
