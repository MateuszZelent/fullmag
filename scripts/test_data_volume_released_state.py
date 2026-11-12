"""Released-state validation on retained byte fixtures, without Docker."""
import hashlib
import inspect
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from scripts.data_volume_released_state import collect_released_state


class ReleasedStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root/'store'; (self.store/'runs').mkdir(parents=True)
        self.ledger = self.root/'ledger'; (self.ledger/'proofs').mkdir(parents=True)
        self.proof = {'schema_version':'host_resource_release_proof.v2', 'host_id':'host',
                      'store_id':'store', 'request_sha256':'1'*64}
        raw = json.dumps(self.proof, sort_keys=True).encode()
        self.proof_sha = hashlib.sha256(raw).hexdigest()
        (self.ledger/'proofs'/(self.proof_sha+'.json')).write_bytes(raw)
        self.doc = {'policy':{'host_id':'host'}, 'reservations':[
            {'state':'released', 'identity':{'store_id':'store'},
             'request_sha256':'1'*64, 'release_proof_sha256':self.proof_sha}]}
        self.save_ledger()
        self.lease = self.store/'runs/run/resource_leases/cpu/lease.json'
        self.lease.parent.mkdir(parents=True)
        self.lease.write_text('{"state":"released"}')

    def save_ledger(self):
        (self.ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps(self.doc))

    def collect(self):
        return collect_released_state(self.store, self.ledger)

    def test_released_rows_and_both_lease_families_are_retained_without_writes(self):
        preparation = self.store/'runs/run/preparation_resource_leases/mesh/lease.json'
        preparation.parent.mkdir(parents=True); preparation.write_text('{"state":"released"}')
        before = {str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = self.collect()
        self.assertEqual(result['active_count'], 0)
        self.assertEqual(result['schema'], 'fullmag.pre-ack-released-observation.v1')
        self.assertEqual(result['reservations'], [[{'store_id':'store'}, '1'*64, self.proof_sha]])
        self.assertEqual({row[0] for row in result['leases']}, {
            'runs/run/resource_leases/cpu/lease.json', 'runs/run/preparation_resource_leases/mesh/lease.json'})
        self.assertEqual(before, {str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_active_reservation_is_rejected_even_when_local_leases_are_released(self):
        self.doc['reservations'][0]['state'] = 'active'; self.save_ledger()
        with self.assertRaisesRegex(ValueError, 'Host reservation'):
            self.collect()

    def test_each_active_lease_family_blocks_release(self):
        self.lease.write_text('{"state":"active"}')
        with self.assertRaisesRegex(ValueError, 'Local lease'):
            self.collect()
        self.lease.write_text('{"state":"released"}')
        preparation = self.store/'runs/run/preparation_resource_leases/mesh/lease.json'
        preparation.parent.mkdir(parents=True); preparation.write_text('{"state":"reserved"}')
        with self.assertRaisesRegex(ValueError, 'Local lease'):
            self.collect()

    def test_proof_digest_and_identity_are_both_required(self):
        path = self.ledger/'proofs'/(self.proof_sha+'.json')
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'digest differs'):
            self.collect()
        self.proof['store_id'] = 'other-store'
        raw = json.dumps(self.proof).encode(); digest = hashlib.sha256(raw).hexdigest()
        (self.ledger/'proofs'/(digest+'.json')).write_bytes(raw)
        self.doc['reservations'][0]['release_proof_sha256'] = digest; self.save_ledger()
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            self.collect()

    def test_ambiguous_json_and_symlinked_lease_cannot_claim_release(self):
        self.lease.write_text('{"state":"active","state":"released"}')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.collect()
        self.lease.unlink(); outside = self.root/'outside.json'
        outside.write_text('{"state":"released"}'); self.lease.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'lease entry'):
            self.collect()

    def test_exact_function_source_can_run_in_a_dependency_free_image(self):
        program = (inspect.getsource(collect_released_state)+
                   '\nimport sys,json;print(json.dumps(collect_released_state(sys.argv[1],sys.argv[2]),sort_keys=True))\n')
        result = subprocess.run([sys.executable, '-I', '-B', '-c', program,
            str(self.store), str(self.ledger)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), self.collect())

    def test_existing_snapshot_uses_the_same_strict_validator(self):
        from scripts import docker_volume_pre_ack_retry as snapshot
        for root in (self.store, self.ledger):
            (root/'WRITER.lock').touch()
        self.lease.write_text('{"state":"active","state":"released"}')
        with mock.patch.object(snapshot, 'docker_capture',
                return_value=subprocess.CompletedProcess([], 0, b'{"active_count":0}', b'')) as docker, \
                mock.patch('docker_volume_linux_supervision_stop.readonly_mount', return_value='fixture'):
            snapshot._released_snapshot(SimpleNamespace(project='fixture'), {'Image':'sha256:'+'a'*64})
        program = docker.call_args.args[-1]
        program = program.replace("'/state/runs/docker-all/session-store'", repr(str(self.store)))
        program = program.replace("'/host-ledger/ledger'", repr(str(self.ledger)))
        result = subprocess.run([sys.executable, '-I', '-B', '-c', program],
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0, 'Ambiguous lease JSON was accepted as released')
        self.assertIn('Duplicate', result.stderr)


if __name__ == '__main__':
    unittest.main()
