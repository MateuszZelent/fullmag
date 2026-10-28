"""Fail-closed evidence gates for diagnostic-only restart recovery."""
import copy
import json
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from docker_volume_restart_recovery import PROBE, validate_terminal_evidence, validate_failed_helper, frontend_process_state
from docker_build_control import BuildControlError

class RestartRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.catalogs = [{"schema_version": "run_catalog.v1", "tasks": [
            {"lifecycle": state} for state in ("succeeded", "failed", "cancelled", "interrupted")]}]
        self.ledger = {"reservations": [{"state": "released", "release_proof_sha256": "a" * 64}]}

    def test_terminal_released_work(self):
        validate_terminal_evidence(self.catalogs, self.ledger)

    def test_nonterminal_or_unknown_task_refused(self):
        for state in ("accepted", "running", "queued", "cancelling", "", None):
            with self.subTest(state=state), self.assertRaises(BuildControlError):
                c = copy.deepcopy(self.catalogs)
                c[0]["tasks"].append({"lifecycle": state})
                validate_terminal_evidence(c, self.ledger)

    def test_active_or_unproven_reservation_refused(self):
        for r in ({"state": "active", "release_proof_sha256": "a" * 64},
                  {"state": "released"}, {"state": "released", "release_proof_sha256": "z" * 64}, None):
            with self.subTest(reservation=r), self.assertRaises(BuildControlError):
                validate_terminal_evidence(self.catalogs, {"reservations": [r]})

    def test_missing_or_malformed_inventory_refused(self):
        for c in (None, [], [None], [{"schema_version": "run_catalog.v1", "tasks": []}],
                  [{"schema_version": "run_catalog.v1", "tasks": [None]}]):
            with self.subTest(catalogs=c), self.assertRaises(BuildControlError):
                validate_terminal_evidence(c, self.ledger)
        for ledger in (None, {}, {"reservations": {}}):
            with self.subTest(ledger=ledger), self.assertRaises(BuildControlError):
                validate_terminal_evidence(self.catalogs, ledger)

    def test_helper_identity_and_active_rejection(self):
        row = dict(Name='/helper', Image='image', State=dict(Status='exited', Running=False, Pid=0, ExitCode=1),
                   Config={'Labels': {'com.docker.compose.project': 'project', 'com.docker.compose.service': 'worker-cgroup-maintenance'}},
                   Mounts=[dict(Type='volume', Name='volume', Destination=p) for p in ('/control', '/fullmag-build-control')])
        validate_failed_helper(row, 'helper', 'project', 'image', 'volume')
        for key,value in (('Running',True), ('Pid',123), ('ExitCode',0), ('Status','running')):
            r=copy.deepcopy(row); r['State'][key]=value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                validate_failed_helper(r, 'helper', 'project', 'image', 'volume')
        for args in (('foreign','project','image','volume'), ('helper','foreign','image','volume'),
                     ('helper','project','foreign','volume'), ('helper','project','image','foreign')):
            with self.subTest(args=args), self.assertRaises(BuildControlError):
                validate_failed_helper(row, *args)

    def test_frontend_health_tick_does_not_hide_process_replacement(self):
        row = {"State": {"Running": True, "Pid": 42, "StartedAt": "start", "Health": {"Status": "healthy"}}}
        before = frontend_process_state(row)
        row["State"]["Health"]["Log"] = [{"End": "later"}]
        self.assertEqual(before, frontend_process_state(row))
        row["State"]["Pid"] = 43
        self.assertNotEqual(before, frontend_process_state(row))

    def test_probe_compiles(self):
        compile(PROBE, "restart-recovery-probe", "exec")


class RestartStoppedFrontendTests(unittest.TestCase):
    def snapshot(self, frontend_state, **kwargs):
        import docker_volume_stop_diagnostic as stop
        ids = {"backend": "b" * 64, "frontend": "f" * 64}
        rows = [{"Id": ids[name], "Image": "sha256:" + "a" * 64,
                 "Config": {"Labels": {"com.docker.compose.project": "project", "com.docker.compose.service": name}},
                 "State": ({"Running": True, "StartedAt": "backend-start"} if name == "backend" else frontend_state)}
                for name in ids]
        def output(value):
            return SimpleNamespace(stdout=value)
        with patch.object(stop, "compose_capture", side_effect=[ids["backend"].encode(), ids["frontend"].encode()]), \
             patch.object(stop, "docker_capture", side_effect=[output(json.dumps(rows).encode()), output(b'[{"Config": {}}]')]), \
             patch("docker_compose_identity.validate_source_labels"), \
             patch("docker_volume_dev._validate_retained_service"), \
             patch("docker_volume_stop_unadmitted._validate_network") as network:
            stop._container_snapshot(SimpleNamespace(), None, {}, SimpleNamespace(project="project"),
                {"inputs": {"image_id": "sha256:" + "a" * 64}, "backend_started_at": "backend-start",
                 "backend_container": ids["backend"], "frontend_container": ids["frontend"]},
                {"services": {"backend": {}, "frontend": {}}}, **kwargs)
            return network.call_args.kwargs

    def stopped_state(self):
        return dict(Status="exited", Running=False, Pid=0, Paused=False, Restarting=False,
                    Dead=False, StartedAt="frontend-start", FinishedAt="frontend-finish")

    def test_stopped_frontend_requires_explicit_recovery_option(self):
        with self.assertRaises(BuildControlError):
            self.snapshot(self.stopped_state())
        self.assertTrue(self.snapshot(self.stopped_state(), allow_stopped_frontend=True)["allow_stopped_frontend"])

    def test_unknown_or_active_frontend_state_is_refused(self):
        for key, value in (("Status", "created"), ("Pid", 123), ("Paused", True),
                           ("Restarting", True), ("Dead", True), ("FinishedAt", "")):
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                state = self.stopped_state(); state[key] = value
                self.snapshot(state, allow_stopped_frontend=True)

    def test_stopped_pair_network_requires_empty_exact_bridge(self):
        import docker_volume_stop_unadmitted as stop
        actual = {name: {"State": {"Running": False}, "NetworkSettings": {"Networks": {"private": {}}}}
                  for name in ("backend", "frontend")}
        ids = {"backend": "b" * 64, "frontend": "f" * 64}
        for consumers in ({}, {ids["backend"]: {}}, {ids["frontend"]: {}}, {"foreign": {}}):
            network = {"Driver": "bridge", "Labels": {"com.docker.compose.project": "project"}, "Containers": consumers}
            with self.subTest(consumers=consumers), patch.object(stop, "_assert_private_restart_network"), \
                 patch.object(stop, "docker_capture", return_value=SimpleNamespace(stdout=json.dumps([network]).encode())):
                if consumers:
                    with self.assertRaises(BuildControlError):
                        stop._validate_network(actual, ids, "project", allow_stopped_frontend=True, allow_stopped_backend=True)
                else:
                    stop._validate_network(actual, ids, "project", allow_stopped_frontend=True, allow_stopped_backend=True)

if __name__ == "__main__":
    unittest.main()
