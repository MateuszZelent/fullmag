"""Fail-closed Linux device re-attestation guards; no runtime or compilation."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from docker_build_control import BuildControlError
import docker_volume_linux_reattest as reattest
import linux_native_host as host


class DeviceReattestationTests(unittest.TestCase):
    def setUp(self):
        self.native = dict(host_root='/state', host_filesystem='ext4', host_platform='linux',
                           host_device=200, host_root_no_reparse=True)
        self.cert = dict(schema=host.HOST_SCHEMA, storage_profile=host.PROFILE,
                         role='session', owner_scope='docker-linux', **self.native,
                         host_inode=7, engine_id='engine', image_id='image',
                         owner_token='a'*32, restart_verified=True)
        self.cert['host_device'] = 100

    def propose(self, cert=None, marker=None, native=None, **kwargs):
        cert = self.cert if cert is None else cert
        return reattest.proposal(cert, cert if marker is None else marker,
            self.native if native is None else native,
            **dict(dict(inode=7, engine_id='engine', image_id='image'), **kwargs))

    def test_only_device_and_restart_gate_change(self):
        new = self.propose()
        self.assertEqual(new, {**self.cert, 'host_device': 200, 'restart_verified': False})
        self.assertEqual(self.cert['host_device'], 100)

    def test_wrong_owner_engine_inode_image_and_unverified_are_rejected(self):
        for change in [dict(engine_id='other'), dict(inode=8), dict(image_id='other')]:
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                self.propose(**change)
        for change in [dict(owner_token='b'*32), dict(restart_verified=False)]:
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                self.propose(marker={**self.cert, **change})
        with self.assertRaises(BuildControlError):
            self.propose(cert={**self.cert, 'restart_verified': False})

    def test_other_volume_changes_and_noop_are_rejected(self):
        for key,value in [('host_root','/another'), ('host_filesystem','xfs'),
                          ('host_root_no_reparse',False), ('host_device',100), ('host_device',True)]:
            with self.subTest(key=key,value=value), self.assertRaises(BuildControlError):
                self.propose(native={**self.native,key:value})

    def test_only_authoritatively_stopped_process_is_admitted(self):
        state = dict(Running=False,Pid=0,Paused=False,Restarting=False,Dead=False)
        reattest.require_stopped(dict(State=state))
        for key,value in [('Running',True), ('Pid',123), ('Paused',True), ('Restarting',True), ('Dead',True)]:
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                reattest.require_stopped(dict(State={**state,key:value}))

    def test_sentinel_and_probe_must_bind_exact_certificate(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            native = {**self.native, 'host_root':str(state)}
            cert = {**self.cert,'host_root':str(state),'host_inode':state.stat().st_ino}
            payload = (cert['owner_token']+':image').encode()
            cert['restart_expected_sha256'] = hashlib.sha256(payload).hexdigest()
            host.publish_evidence(state / host.CERTIFICATE_NAME, cert)
            host.publish_evidence(state / host.OWNER_NAME, cert)
            raw = (state / host.CERTIFICATE_NAME).read_bytes()
            for name in ['.linux-native-sentinel','.linux-native-restart']:
                host.publish_bytes(state / name,payload)
            probe = dict(schema='fullmag.linux-native-probe.v1',image_id='image',owner_token=cert['owner_token'],
                         host_attestation_sha256=hashlib.sha256(raw).hexdigest(),
                         checks={k:True for k in host.CHECKS})
            host.publish_evidence(state / '.linux-native-probe.json',probe)
            with patch.object(reattest,'local_volume',return_value=native):
                self.assertEqual(reattest._evidence(state,'engine','image')[2]['host_device'],200)
                host.publish_bytes(state / '.linux-native-sentinel', b'wrong')
                with self.assertRaisesRegex(BuildControlError,'sentinel/restart/probe'):
                    reattest._evidence(state,'engine','image')


if __name__ == '__main__':
    unittest.main()
