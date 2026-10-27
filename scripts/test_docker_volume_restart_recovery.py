"""Fail-closed evidence gates for diagnostic-only restart recovery."""
import copy
import unittest
from docker_volume_restart_recovery import PROBE, validate_terminal_evidence, validate_failed_helper
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

    def test_probe_compiles(self):
        compile(PROBE, "restart-recovery-probe", "exec")

if __name__ == "__main__":
    unittest.main()
