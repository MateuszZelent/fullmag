"""Focused guards for the initial Compose pool-failure reconciler."""
from __future__ import annotations

import json
import fcntl
import stat
import tempfile
from pathlib import Path
import subprocess
import unittest
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

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


class WindowsBatchTests(unittest.TestCase):
    def test_full_sources_run_in_bounded_parallel_and_preserve_deterministic_results(self):
        sources={f'C:\\foreign\\{i}':{'id':str(i)} for i in range(8)}
        lock=threading.Lock()
        barrier=threading.Barrier(4,timeout=10)
        active=maximum=0
        seen=[]
        context={'linux':{'root_device':1},'distro':'Ubuntu'}
        def observe(source,native,ctx,pin):
            nonlocal active,maximum
            with lock:
                active+=1
                maximum=max(maximum,active)
                seen.append(source)
            try:
                barrier.wait()
                ctx['linux']['root_device']=2
                return {'kind':'present','native':{'source':source},'mapping':{'path':native}}
            finally:
                with lock: active-=1
        with patch.object(reconcile,'_observe_windows_source',side_effect=observe):
            results=reconcile._windows_source_batch(sources,context)
        self.assertEqual(maximum,4)
        self.assertEqual(active,0)
        self.assertCountEqual(seen,sources)
        self.assertEqual(list(results),list(sources))
        self.assertEqual(context['linux']['root_device'],1)
        self.assertEqual(set(results),set(sources))
        for source,evidence in results.items(): self.assertEqual(evidence['native']['source'],source)

    def test_failure_or_incomplete_result_discards_whole_batch_and_joins_workers(self):
        for result in (BuildControlError('native qualification refused'),TimeoutError('timeout'),None,{}):
            with self.subTest(result=result):
                def observe(*args):
                    if isinstance(result,Exception): raise result
                    return result
                with patch.object(reconcile,'_observe_windows_source',side_effect=observe):
                    with self.assertRaises((BuildControlError,TimeoutError)):
                        reconcile._windows_source_batch({'C:\\foreign':{'id':'b'}},{})

    def test_prewarm_deduplicates_source_but_never_consumer_authorization(self):
        source=r'C:\git\foreign'
        stopped={'id':'b'*64,'running':False}
        running={'id':'c'*64,'running':True}
        docs=[{**stopped,'Mounts':[{'Type':'bind','Source':source}]},
              {**running,'Mounts':[{'Type':'bind','Source':source}]}]
        compose={'services':{'backend':{'volumes':[{'type':'bind','target':'/state','source':'/reference'}]}}}
        evidence={'kind':'absent-stopped','native':{},'mapping':{}}
        def must_stay_stopped(pin):
            if pin['running']: raise BuildControlError('running consumer')
        with patch.dict(reconcile.os.environ,{'WSL_DISTRO_NAME':'Ubuntu'}), \
             patch.object(reconcile.windows,'_linux_identity',return_value={'root_device':1,'engine_id':'engine'}), \
             patch.object(reconcile.windows,'_engine',return_value={'ID':'engine'}), \
             patch.object(reconcile.windows,'_container_pin',side_effect=lambda d:{'id':d['id'],'running':d['running']}), \
             patch.object(reconcile,'_observe_windows_source',return_value=evidence) as measure, \
             patch.object(reconcile.absent_windows,'_stopped',side_effect=must_stay_stopped):
            qualify,verify=reconcile._initial_desktop_qualifier(IDENTITY,compose,'engine',candidates=docs)
            self.assertEqual(measure.call_count,1)
            qualify(stopped,source)
            with self.assertRaisesRegex(BuildControlError,'running consumer'): qualify(running,source)

    def test_prewarm_matches_lazy_proof_and_rechecks_context_after_full_refresh(self):
        source=r'C:\git\foreign'
        doc={'id':'b'*64,'Mounts':[{'Type':'bind','Source':source}]}
        compose={'services':{'backend':{'volumes':[{'type':'bind','target':'/state','source':'/reference'}]}}}
        linux={'root_device':1,'engine_id':'engine','source_root':'/source','reference_root':'/reference'}
        proof={'kind':'present','native':{'identity':'full'},'mapping':{'path':'/mapped'}}
        with patch.dict(reconcile.os.environ,{'WSL_DISTRO_NAME':'Ubuntu'}), \
             patch.object(reconcile.windows,'_linux_identity',return_value=linux), \
             patch.object(reconcile.windows,'_engine',return_value={'ID':'engine'}) as engine, \
             patch.object(reconcile.windows,'_container_pin',side_effect=lambda d:{'id':d['id']}), \
             patch.object(reconcile.windows,'_inspect',return_value=doc), \
             patch.object(reconcile,'_observe_windows_source',return_value=proof):
            lazy,verify_lazy=reconcile._initial_desktop_qualifier(IDENTITY,compose,'engine')
            expected=lazy(doc,source)
            verify_lazy(refresh_windows=True)
            parallel,verify_parallel=reconcile._initial_desktop_qualifier(IDENTITY,compose,'engine',candidates=[doc])
            self.assertEqual(parallel(doc,source),expected)
            verify_parallel(refresh_windows=True)
            engine.return_value={'ID':'changed'}
            with self.assertRaisesRegex(BuildControlError,'context changed'):
                verify_parallel(refresh_windows=True)


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

    def test_windows_binds_require_and_retain_exact_evidence(self):
        foreign = {**helper_doc(), "Id": "b" * 64, "Name": "/foreign", "Config": {}}
        sources = [r"C:\git\foreign", "/run/desktop/mnt/host/e/git/foreign"]
        foreign["Mounts"] = [{"Type": "bind", "Source": source} for source in sources]
        args = dict(helper_id="a" * 64, helper_name="fullmag-control-" + ATTEMPT,
                    project=PROJECT, network_name=NETWORK, identity=IDENTITY, control_volume="own-control")
        with self.assertRaisesRegex(BuildControlError, "requires initial recovery isolation evidence"):
            reconcile.validate_container_inventory([helper_doc(), foreign], **args)
        proof = Mock(side_effect=lambda doc, source: (None, {"bind": source, "id": doc["Id"]}))
        result = reconcile.validate_container_inventory([helper_doc(), foreign], qualify_desktop_bind=proof, **args)
        self.assertEqual({entry["bind"] for entry in result if "bind" in entry}, set(sources))
        self.assertEqual([call.args for call in proof.call_args_list], [(foreign, source) for source in sources])

    def test_desktop_alias_cannot_hide_checkout_overlap(self):
        foreign = {**helper_doc(), "Id": "b" * 64, "Name": "/foreign", "Config": {}}
        alias = reconcile.WSL_ALIAS + "Ubuntu/" + "0" * 64
        args = dict(helper_id="a" * 64, helper_name="fullmag-control-" + ATTEMPT,
                    project=PROJECT, network_name=NETWORK, identity=IDENTITY, control_volume="own-control")
        for source in (alias, "/run/desktop/mnt/host/c"):
            foreign["Mounts"] = [{"Type": "bind", "Source": source}]
            with self.subTest(source=source), self.assertRaisesRegex(BuildControlError, "requires initial"):
                reconcile.validate_container_inventory([helper_doc(), foreign], **args)
        foreign["Mounts"] = [{"Type": "bind", "Source": alias}]
        with self.assertRaisesRegex(BuildControlError, "consumes this group"):
            reconcile.validate_container_inventory(
                [helper_doc(), foreign], **args,
                qualify_desktop_bind=lambda *_: (IDENTITY["source_root"], {"source": alias}),
            )

    def test_external_junction_requires_exact_drvfs_target_and_own_proof(self):
        source = r"C:\git\foreign"
        target = r"E:\git\storage\target"
        origin = {"path": "/mnt/c/git/foreign", "mode": stat.S_IFDIR, "device": 2}
        destination = {"path": "/mnt/e/git/storage/target", "mode": stat.S_IFDIR, "device": 3}
        native = {"candidate": {"path": source, "kind": "directory"}}
        target_native = {"candidate": {"path": target, "kind": "directory"}}
        record = {"tag": "0xa0000003", "target": target}
        with (
            patch.object(reconcile.windows, "_mapping", side_effect=lambda s: origin if s == source else destination),
            patch.object(reconcile.windows, "_native", side_effect=lambda s, *a, **kw: native if s == source else target_native) as observe,
            patch.object(reconcile.windows, "_link_paths", return_value=[("target", "target", record)]),
            patch.object(reconcile.windows, "_link_parent_directories"),
            patch.object(reconcile.windows, "_file_identity", return_value={"mode": stat.S_IFLNK, "device": 2}),
            patch.object(reconcile.windows, "_qualify_links", return_value=[]),
            patch.object(reconcile.os, "readlink", return_value=destination["path"]) as readlink,
        ):
            proof = reconcile._observe_present_windows_bind(source, "Ubuntu", 1)
            self.assertEqual(proof["external_junctions"]["target"]["native"], target_native)
            observe.assert_any_call(target, "Ubuntu")
            readlink.return_value = "/home/user/protected"
            with self.assertRaisesRegex(BuildControlError, "exact disjoint DrvFs"):
                reconcile._observe_present_windows_bind(source, "Ubuntu", 1)

    def test_publication_refresh_rejects_changed_windows_evidence(self):
        compose = {"services": {"backend": {"volumes": [
            {"type": "bind", "target": "/state", "source": "/state/reference"},
        ]}}}
        source = r"C:\git\foreign"
        pin = {"id": "b" * 64}
        with (
            patch.dict(reconcile.os.environ, {"WSL_DISTRO_NAME": "Ubuntu"}),
            patch.object(reconcile.windows, "_linux_identity", return_value={"root_device": 1, "engine_id": "engine"}),
            patch.object(reconcile.windows, "_engine", return_value={"ID": "engine"}),
            patch.object(reconcile.windows, "_container_pin", return_value=pin),
            patch.object(reconcile, "_observe_windows_source",
                         side_effect=[{"kind": "present", "inode": 12, "native": {}, "mapping": {}}, {"kind": "present", "inode": 13, "native": {}, "mapping": {}}]),
        ):
            qualify, verify = reconcile._initial_desktop_qualifier(IDENTITY, compose, "engine")
            qualify({}, source)
            with self.assertRaisesRegex(BuildControlError, "changed before failure publication") as refused:
                verify(refresh_windows=True)
            self.assertIn(source, str(refused.exception))
            self.assertIn('observation.inode', str(refused.exception))

    def test_parallel_refresh_still_rejects_ordinary_inventory_drift(self):
        compose={'services':{'backend':{'volumes':[{'type':'bind','target':'/state','source':'/reference'}]}}}
        source=r'C:\git\foreign'
        before={'kind':'present','native':{'candidate':{'descendants':{'entries':1}}},'mapping':{}}
        after={'kind':'present','native':{'candidate':{'descendants':{'entries':2}}},'mapping':{}}
        with patch.dict(reconcile.os.environ,{'WSL_DISTRO_NAME':'Ubuntu'}), \
             patch.object(reconcile.windows,'_linux_identity',return_value={'root_device':1,'engine_id':'engine'}), \
             patch.object(reconcile.windows,'_engine',return_value={'ID':'engine'}), \
             patch.object(reconcile.windows,'_container_pin',return_value={'id':'b'*64}), \
             patch.object(reconcile,'_observe_windows_source',side_effect=[before,after]):
            qualify,verify=reconcile._initial_desktop_qualifier(IDENTITY,compose,'engine')
            qualify({},source)
            with self.assertRaisesRegex(BuildControlError,'observation.native.candidate.descendants.entries'):
                verify(refresh_windows=True)

    def test_vanishing_container_retries_full_inventory(self):
        error = BuildControlError("error: no such object: " + "c" * 64)
        with patch.object(reconcile, "_inspect_inventory_snapshot", side_effect=[error, [helper_doc()]]) as inspect:
            self.assertEqual(reconcile._container_inventory(), [helper_doc()])
            self.assertEqual(inspect.call_count, 2)

    def test_absent_windows_evidence_cannot_be_reused_after_container_starts(self):
        source = r"C:\git\missing"
        compose = {"services": {"backend": {"volumes": [
            {"type": "bind", "target": "/state", "source": "/state/reference"},
        ]}}}
        stopped = {"id": "b" * 64, "state": {
            "Status": "exited", "Running": False, "Paused": False, "Restarting": False,
            "Dead": False, "Pid": 0,
        }}
        running = {"id": "c" * 64, "state": {**stopped["state"], "Status": "running", "Running": True}}
        with (
            patch.dict(reconcile.os.environ, {"WSL_DISTRO_NAME": "Ubuntu"}),
            patch.object(reconcile.windows, "_linux_identity", return_value={"root_device": 1, "engine_id": "engine"}),
            patch.object(reconcile.windows, "_engine", return_value={"ID": "engine"}),
            patch.object(reconcile.windows, "_container_pin", side_effect=lambda value: value),
            patch.object(reconcile.windows, "_capture", return_value=b"/mnt/c/git/missing"),
            patch.object(reconcile.Path, "lstat", side_effect=FileNotFoundError),
            patch.object(reconcile.absent_windows, "_native", return_value={"missing": True}) as native,
            patch.object(reconcile.absent_windows, "_mapping", return_value={"device": 2}),
        ):
            qualify, _ = reconcile._initial_desktop_qualifier(IDENTITY, compose, "engine")
            self.assertEqual(qualify(stopped, source)[1]["kind"], "absent-stopped")
            with self.assertRaisesRegex(BuildControlError, "exactly stopped"):
                qualify(running, source)
            native.assert_called_once_with(source)

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
            result=files[root+'/reconciliation/recoveries/'+self.args.recovery_id+'/result.json']
            for p in (root+'/receipt.json',root+'/terminal.json','development/current.json'): files[p]=result
            return subprocess.CompletedProcess([],0,b'',b'')
        with patch.object(reconcile,'_identity_and_control',return_value=(Path(IDENTITY['source_root']),IDENTITY,self.control)), \
             patch.object(reconcile,'read_raw',side_effect=read), \
             patch.object(reconcile,'write_immutable',side_effect=write), \
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
    def run_publication(self, *, corrupt=False, symlink=False, recovery=False, corrupt_previous=False):
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
                if corrupt_previous:
                    (root/'reconciliation/prepared.json').write_bytes(b'changed')
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
                completed = subprocess.run(["bash", "-euc", script], capture_output=True)
            self.assertEqual((base / "active").read_text(), ATTEMPT + "\n")
            self.assertFalse((base / "development/verified.json").exists())
            if corrupt or symlink or corrupt_previous:
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

    def test_prepared_generation_cas_preserves_old_files(self):
        self.run_publication(recovery=True)

    def test_prepared_generation_cas_rejects_old_preparation_changed_after_observation(self):
        self.run_publication(recovery=True, corrupt_previous=True)


if __name__ == "__main__":
    unittest.main()
