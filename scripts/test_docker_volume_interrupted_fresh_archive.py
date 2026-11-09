from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import docker_volume_interrupted_fresh_archive as recovery
from docker_build_control import BuildControlError, canonical, control_read_script


PRIOR = "d3434e2354454552a7f777daef505d82"
RECREATE = "bb7bfa3030c64aa1b102f4b93f3984fd"
ACTIVATION = "eddf316739494473ab70a0babeb1333c"
PROJECT = "fullmag-worktree-fullmag-a8342df1f0247d61"
BACKEND = "52aeca410cb31b3480d88807e47d99d62fdf985e00ce51ac897899f8674df3dc"
FRONTEND = "14a93e5701a946132a37144827b06795f9c11882eaa8b851ef7d8e8b8864ac6a"
IMAGE = "sha256:" + "1" * 64
CONFIG_SHA = hashlib.sha256(canonical({
    "name": PROJECT,
    "services": {"backend": {}, "frontend": {}},
})).hexdigest()
SOURCE = "/registered/fullmag/worktree"
STATE = "/retained/state/root"
UNKNOWN_SHA = "f" * 64
ENGINE = "test-engine-id"
HELPER_ID = "f0480a9b63fad31a58ea362dc268593e5bf26ef45c8164b40f57ef0777468ced"
CONTROL_VOLUME = "fullmag-build-control-test"


def fixtures():
    identity = {
        "project_name": PROJECT,
        "project_id": "fullmag-project-id",
        "worktree_id": "fullmag-a8342df1f0247d61",
        "checkout_kind": "worktree",
        "source_root": SOURCE,
    }
    compose = {"name": PROJECT, "services": {"backend": {}, "frontend": {}}}
    previous = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "development",
        "state": "succeeded",
        "attempt": PRIOR,
        "compose_project": PROJECT,
        "config_sha256": CONFIG_SHA,
        "state_root": STATE,
        "backend_container": BACKEND,
        "frontend_container": FRONTEND,
        "backend_volumes": {"cache": "retained"},
        "frontend_volume": "frontend-retained",
        "inputs": {
            "source_root": SOURCE,
            "image_id": IMAGE,
            "source_project_id": identity["project_id"],
            "source_worktree_id": identity["worktree_id"],
            "source_checkout_kind": identity["checkout_kind"],
        },
    }
    receipt = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "recreate-services",
        "state": "outcome-unknown-resources-retained",
        "attempt": RECREATE,
        "compose_project": PROJECT,
        "control_volume": CONTROL_VOLUME,
        "helper_container": "fullmag-control-" + RECREATE,
        "control_namespace": "",
        "fresh_state": True,
        "previous_state_root": STATE,
        "started_at": 1.0,
        "finished_at": 2.0,
        "error": "Archived group ledger still has a container consumer",
        "inputs": {"attempt": PRIOR, "config_sha256": CONFIG_SHA},
    }
    retained = {
        "backend": {
            "Id": BACKEND,
            "Config": {"Labels": {"com.docker.compose.project": PROJECT,
                                    "com.docker.compose.service": "backend"}},
            "State": {"Running": False, "ExitCode": 0,
                      "StartedAt": "2026-11-02T20:38:42.643427591Z"},
        },
        "frontend": {
            "Id": FRONTEND,
            "Config": {"Labels": {"com.docker.compose.project": PROJECT,
                                    "com.docker.compose.service": "frontend"}},
            # This is the pre-stop snapshot. The recovery proof does not claim
            # an exit code for this frontend generation.
            "State": {"Running": True,
                      "StartedAt": "2026-11-02T20:38:43.250562017Z"},
        },
    }
    recovery_record = {
        "schema": "fullmag.cancelled-activation-recovery.v1",
        "state": "stopped-awaiting-fresh-archive",
        "activation_attempt": ACTIVATION,
        "development_attempt": PRIOR,
        "config_sha256": CONFIG_SHA,
        "source_root": SOURCE,
        "image_id": IMAGE,
        "backend_container": BACKEND,
        "backend_started_at": "2026-11-02T20:38:42.643427591Z",
        "frontend_container": FRONTEND,
        "frontend_started_at": "2026-11-02T20:38:43.250562017Z",
        "state_root": STATE,
        "original_receipt_sha256": UNKNOWN_SHA,
        "restart_policy": "fresh-state-only",
        "execution_state": "not-started",
        "compose_project": PROJECT,
        "control_volume": CONTROL_VOLUME,
        "control_namespace": "",
        "source_sha256": "6" * 64,
        "journal_path": "verification/cancelled-activation-" + ACTIVATION + "/journal.json",
        "journal_sha256": "7" * 64,
        "request_id": "sp4_relax_fdm_gpu_observed_20261102_02",
    }
    pins = {
        "prior_attempt": PRIOR,
        "recreation_attempt": RECREATE,
        "config_sha256": CONFIG_SHA,
        "source_root": SOURCE,
        "unknown_receipt_sha256": UNKNOWN_SHA,
        "helper_container_id": HELPER_ID,
        "helper_image": "nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:" + "a" * 64,
        "engine_id": ENGINE,
    }
    return identity, compose, previous, receipt, retained, recovery_record, pins


class PreparedCompletedArchiveTests(unittest.TestCase):
    def setUp(self):
        import json
        from types import SimpleNamespace
        import docker_volume_linux_supervision_stop as prepared
        from docker_volume_fresh_runtime import _archive_mapping
        identity, compose, previous, receipt, retained, _, pins = fixtures()
        self.root = 'recreate-services/attempts/' + RECREATE
        self.docs = {}
        self.publications = []
        self.fault = None
        self.on_publish = None
        self.put = lambda path, value: self.docs.__setitem__(path, canonical(value) + b'\n')
        quarantine = {'schema': prepared.PREPARED_QUARANTINE_SCHEMA, 'state': 'cancellation-required',
                      'scope': {'state_root': STATE}, 'target': {'run_id': 'run-target', 'task_id': 'task-target', 'request_id': 'old-request'}}
        self.put(prepared.PREPARED_QUARANTINE, quarantine)
        quarantine_sha = recovery._sha(self.docs[prepared.PREPARED_QUARANTINE])
        for path in ('development/current.json', 'development/verified.json', 'development/attempts/' + PRIOR + '/terminal.json'):
            self.put(path, previous)
        constraints = {'quarantine_sha256': quarantine_sha, 'target': quarantine['target']}
        witness = {'schema': 'fullmag.docker-prepared-cancelled-fresh-admission.v1',
                   'quarantine_sha256': quarantine_sha,
                   'cancellation_terminal_sha256': recovery._sha(self.docs['development/current.json']),
                   'constraints': constraints}
        receipt['error'] = 'Prepared archive quarantine publication acknowledgement was lost'
        receipt['prepared_cancelled_fresh_admission'] = witness
        self.put(self.root + '/receipt.json', receipt)
        self.put(self.root + '/retained-containers.json', retained)
        intent = {'schema': 'fullmag.docker-fresh-runtime-archive-intent.v1', 'operation_attempt': RECREATE,
                  'compose_project': PROJECT, 'control_volume': CONTROL_VOLUME, 'control_namespace': '',
                  'source_root': SOURCE, 'previous_state_root': STATE,
                  'removed_containers': {'backend': BACKEND, 'frontend': FRONTEND},
                  'mapping': _archive_mapping(RECREATE, private_ledger=False), 'runtime_control_device_inode': '1:10'}
        self.put(self.root + '/runtime-control-archive-intent.json', intent)
        archive = {'schema': 'fullmag.docker-fresh-runtime-archive-terminal.v1', 'state': 'succeeded',
                   'operation_attempt': RECREATE, 'compose_project': PROJECT, 'control_volume': CONTROL_VOLUME,
                   'control_namespace': '', 'intent_sha256': recovery._sha(self.docs[self.root + '/runtime-control-archive-intent.json']),
                   'mapping': intent['mapping'], 'removed_containers': intent['removed_containers'],
                   'preserved_group_ledger_volume': CONTROL_VOLUME,
                   'preserved_runtime_control_device_inode': '1:10', 'fresh_runtime_control_device_inode': '1:11'}
        self.put(self.root + '/runtime-control-archive-terminal.json', archive)
        self.put('group-ledger-generation.json', {
            'schema': 'fullmag.docker-group-ledger-generation.v1', 'compose_project': PROJECT,
            'generation': RECREATE, 'preserved_volume': CONTROL_VOLUME,
            'archive_terminal_path': self.root + '/runtime-control-archive-terminal.json',
            'archive_terminal_sha256': recovery._sha(canonical(archive))})
        pins.update(unknown_receipt_sha256=recovery._sha(self.docs[self.root + '/receipt.json']),
                    prepared_quarantine_sha256=quarantine_sha,
                    prepared_archive_terminal_sha256=recovery._sha(self.docs[self.root + '/runtime-control-archive-terminal.json']))
        self.args = SimpleNamespace(**pins, apply=False, expected_plan_sha256=None)
        self.docs['active'] = RECREATE.encode() + b'\n'
        def read_bytes(path, optional=False, **kwargs):
            if optional:
                return self.docs.get(path)
            if path not in self.docs:
                raise BuildControlError('Required retained evidence is missing: ' + path)
            return self.docs[path]
        self.control = SimpleNamespace(project=PROJECT, volume=CONTROL_VOLUME, namespace='', identity=identity,
                                       read_bytes=read_bytes, read=lambda path, **kw: json.loads(read_bytes(path, **kw)),
                                       _active_operation=None)
        self.validated = ({'native_result': {'disposition': 'cancelled'}}, b'', b'',
                          {'run_id': 'run-target', 'task_id': 'task-target'}, b'',
                          {'prepared_unclaimed_quarantine': constraints}, b'', compose, b'')
        def cas(control, path, raw, expected):
            current = self.docs.get(path)
            actual = 'ABSENT' if current is None else recovery._sha(current)
            if actual != expected and current != raw:
                raise BuildControlError('CAS changed: ' + path)
            self.publications.append(path)
            self.docs[path] = raw
            if self.on_publish is not None:
                self.on_publish(path)
            if path == self.root + '/terminal.json':
                self.docs.pop('active', None)
            if self.fault == path:
                self.fault = None
                raise BuildControlError('lost publication acknowledgement')
        def immutable(control, path, raw):
            cas(control, path, raw, 'ABSENT')
        def quarantine_cas(control, path, value, *, expected_raw):
            cas(control, path, canonical(value) + b'\n', 'ABSENT' if expected_raw is None else recovery._sha(expected_raw))
            return canonical(value) + b'\n'
        self.observers = []
        def start_observer(*args):
            process = subprocess.Popen(['/bin/cat'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.observers.append(process)
            return process
        def wait_release(control, helper_id, observer):
            observer.stdin.close()
            return observer.wait(timeout=5)
        def cleanup():
            for process in self.observers:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
                process.wait(timeout=5)
        self.addCleanup(cleanup)
        patches = [patch.object(recovery, '_prepare_control', return_value=self.control),
                   patch.object(recovery, '_assert_engine'), patch.object(recovery, '_check_host_writer_processes'),
                   patch.object(recovery, '_inspect_pinned_helper'), patch.object(recovery, '_assert_active_marker'),
                   patch.object(recovery, '_assert_logged'), patch.object(recovery, '_start_observer', side_effect=start_observer),
                   patch.object(recovery, '_wait_original_release', side_effect=wait_release),
                   patch.object(recovery, '_cas_publish', side_effect=cas),
                   patch.object(recovery, '_publish_immutable', side_effect=immutable),
                   patch('docker_volume_cancelled_activation._publish_cas', side_effect=quarantine_cas),
                   patch('docker_volume_cancelled_recovery._validate_operation', side_effect=lambda *a: self.validated),
                   patch('docker_volume_fresh_runtime._assert_exact_absence'),
                   patch('docker_volume_fresh_runtime._operation_helper', return_value=(HELPER_ID, {})),
                   patch('docker_volume_fresh_runtime._archive_runtime_control', return_value={
                       'preserved_runtime_control_device_inode': '1:10', 'fresh_runtime_control_device_inode': '1:11'}),
                   patch('docker_volume_fresh_runtime.archive_runtime_control', side_effect=AssertionError('physical archive must never repeat'))]
        for item in patches:
            mock = item.start()
            self.addCleanup(item.stop)
            if item.attribute == '_archive_runtime_control':
                self.verify = mock

    def apply_from_preview(self):
        self.args.apply = False
        self.args.expected_plan_sha256 = None
        preview = recovery.prepared_completed_archive(self.args)
        self.args.apply = True
        self.args.expected_plan_sha256 = preview['plan_sha256']
        return recovery.prepared_completed_archive(self.args)

    def test_completed_physical_archive_before_quarantine_cas_is_finished_without_inspecting_old_live_ids(self):
        original = recovery.strict_object(self.docs[self.root + '/receipt.json'], 'real recreate receipt shape')
        self.assertEqual(original['inputs'], {'attempt': PRIOR, 'config_sha256': CONFIG_SHA})
        result = self.apply_from_preview()
        self.assertEqual(result['state'], 'succeeded')
        self.assertFalse(result['services_started'])
        self.assertFalse(result['solve_replayed'])
        self.assertEqual(self.publications[-1], self.root + '/terminal.json')
        self.assertTrue(self.observers)
        for call in self.verify.call_args_list:
            self.assertIs(call.kwargs['verify_only'], True)
        for path in ('receipt.json', 'terminal.json'):
            self.assertEqual(self.docs[self.root + '/' + path], self.docs['recreate-services/current.json'])

    def test_quarantine_already_published_before_operation_terminal_is_idempotent(self):
        import docker_volume_linux_supervision_stop as prepared
        receipt = recovery.strict_object(self.docs[self.root + '/receipt.json'], 'original')
        prepared.pin_prepared_fresh_archive(self.control, {'root': self.root, 'receipt': receipt}, receipt['prepared_cancelled_fresh_admission'])
        result = self.apply_from_preview()
        self.assertEqual(result['state'], 'succeeded')

    def test_interrupted_finisher_after_quarantine_or_receipt_publication_resumes_exact_bytes(self):
        import docker_volume_linux_supervision_stop as prepared
        for path in (prepared.PREPARED_QUARANTINE, self.root + '/receipt.json', self.root + '/terminal.json'):
            with self.subTest(path=path):
                # Each fault case uses independent complete boundary evidence.
                case = PreparedCompletedArchiveTests('test_completed_physical_archive_before_quarantine_cas_is_finished_without_inspecting_old_live_ids')
                case.setUp()
                try:
                    case.fault = path
                    with self.assertRaisesRegex(BuildControlError, 'lost publication'):
                        case.apply_from_preview()
                    result = case.apply_from_preview()
                    self.assertIn(result['state'], ('succeeded', 'already-succeeded'))
                    for call in case.verify.call_args_list:
                        self.assertIs(call.kwargs['verify_only'], True)
                finally:
                    case.doCleanups()

    def test_missing_or_foreign_completed_terminal_refuses_before_any_publication(self):
        path = self.root + '/runtime-control-archive-terminal.json'
        original = self.docs.pop(path)
        with self.assertRaisesRegex(BuildControlError, 'missing'):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])
        self.docs[path] = original
        self.docs[path] = canonical({'schema': 'foreign', 'state': 'succeeded'})
        with self.assertRaises(BuildControlError):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])
        self.assertFalse(self.observers)

    def test_inode_drift_or_deferred_native_cancellation_refuses_before_writes(self):
        self.verify.return_value = {'preserved_runtime_control_device_inode': 'changed'}
        with self.assertRaisesRegex(BuildControlError, 'inode evidence drifted'):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])
        self.verify.return_value = {}
        self.validated[0]['native_result']['disposition'] = 'cancellation_requested_projection_deferred'
        with self.assertRaisesRegex(BuildControlError, 'canonical native cancellation'):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])

    def test_archive_source_drift_cannot_be_authorized_by_new_digest_alone(self):
        intent_path = self.root + '/runtime-control-archive-intent.json'
        terminal_path = self.root + '/runtime-control-archive-terminal.json'
        intent = recovery.strict_object(self.docs[intent_path], 'intent')
        intent['source_root'] = '/foreign/source'
        self.put(intent_path, intent)
        terminal = recovery.strict_object(self.docs[terminal_path], 'terminal')
        terminal['intent_sha256'] = recovery._sha(self.docs[intent_path])
        self.put(terminal_path, terminal)
        self.args.prepared_archive_terminal_sha256 = recovery._sha(self.docs[terminal_path])
        with self.assertRaisesRegex(BuildControlError, 'this exact operation'):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])

    def test_missing_or_stale_group_ledger_generation_is_unsupported_partial_archive(self):
        original = self.docs.pop('group-ledger-generation.json')
        with self.assertRaisesRegex(BuildControlError, 'missing'):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])
        generation = recovery.strict_object(original, 'generation')
        generation['generation'] = 'a' * 32
        self.put('group-ledger-generation.json', generation)
        with self.assertRaises(BuildControlError):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])

    def test_generation_drift_after_preview_cannot_finish_or_publish(self):
        preview = recovery.prepared_completed_archive(self.args)
        generation = recovery.strict_object(self.docs['group-ledger-generation.json'], 'generation')
        generation['archive_terminal_sha256'] = '0' * 64
        self.put('group-ledger-generation.json', generation)
        self.args.apply = True
        self.args.expected_plan_sha256 = preview['plan_sha256']
        with self.assertRaises(BuildControlError):
            recovery.prepared_completed_archive(self.args)
        self.assertEqual(self.publications, [])

    def test_generation_drift_during_finalization_cannot_publish_terminal(self):
        def change_generation(path):
            if path == self.root + '/receipt.json':
                generation = recovery.strict_object(self.docs['group-ledger-generation.json'], 'generation')
                generation['archive_terminal_sha256'] = '0' * 64
                self.put('group-ledger-generation.json', generation)
        self.on_publish = change_generation
        with self.assertRaisesRegex(BuildControlError, 'generation drifted'):
            self.apply_from_preview()
        self.assertNotIn(self.root + '/terminal.json', self.docs)
        for call in self.verify.call_args_list:
            self.assertIs(call.kwargs['verify_only'], True)


class InterruptedFreshArchiveTests(unittest.TestCase):
    def test_record_budget_is_accepted_by_the_real_control_reader(self):
        control_read_script("/control/recreate-services/current.json", recovery.MAX_RECORD_BYTES)

    def test_activation_terminal_authenticates_exact_recovery_bytes_including_newline(self):
        from docker_volume_cancelled_activation_guard import RECORD
        _, _, _, _, _, record, pins = fixtures()
        journal_raw = b"journal\n"
        record["journal_sha256"] = hashlib.sha256(journal_raw).hexdigest()
        record_raw = canonical(record) + b"\n"
        terminal = {
            "state": "failed-confirmed",
            "activation_state": "operator-cancelled-after-confirmed-drain",
            "cancelled_recovery_sha256": hashlib.sha256(record_raw).hexdigest(),
        }
        values = {
            RECORD: record_raw,
            record["journal_path"]: journal_raw,
            "activation/attempts/" + ACTIVATION + "/terminal.json": canonical(terminal) + b"\n",
        }
        control = Mock()
        control.read_bytes.side_effect = lambda path, **kwargs: values[path]
        with patch("docker_volume_cancelled_activation_guard.read_record", return_value=record):
            observed, object_sha, journal_sha = recovery._read_recovery_evidence(control, pins)
            self.assertEqual(observed, record)
            self.assertEqual(object_sha, hashlib.sha256(canonical(record)).hexdigest())
            self.assertEqual(journal_sha, record["journal_sha256"])
            values[RECORD] = record_raw + b" "
            with self.assertRaises(BuildControlError):
                recovery._read_recovery_evidence(control, pins)

    def test_exact_fresh_unknown_and_cancelled_snapshot_qualifies(self):
        identity, compose, previous, receipt, retained, recovery_record, pins = fixtures()
        result = recovery.validate_snapshot(
            pins, receipt, previous, compose, retained, recovery_record,
            identity=identity, control_volume=CONTROL_VOLUME, namespace="",
        )
        self.assertEqual(result["removed_containers"], [BACKEND, FRONTEND])
        self.assertEqual(result["previous_state_root"], STATE)
        self.assertEqual(result["frontend_snapshot_state"], "pre-stop-running")

    def test_wrong_config_hash_and_operation_attempt_fail_closed(self):
        identity, compose, previous, receipt, retained, recovery_record, pins = fixtures()
        pins["config_sha256"] = "8" * 64
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       recovery_record, identity=identity,
                                       control_volume=CONTROL_VOLUME, namespace="")
        _, _, _, receipt, retained, recovery_record, pins = fixtures()
        receipt["attempt"] = "0" * 32
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       recovery_record, identity=identity,
                                       control_volume=CONTROL_VOLUME, namespace="")

    def test_wrong_lane_not_fresh_or_nonunknown_receipt_is_rejected(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        receipt["fresh_state"] = False
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        _, _, _, receipt, retained, record, pins = fixtures()
        receipt["state"] = "failed-confirmed"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")

    def test_cancelled_record_must_bind_exact_stopped_backend_and_fresh_only_policy(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record["backend_started_at"] = "changed-incarnation"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record["restart_policy"] = "resume-existing-state"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")

    def test_wrong_source_control_volume_and_missing_cancellation_fence_are_rejected(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record["control_volume"] = "foreign-control-volume"
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        record.pop("journal_sha256")
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")

    def test_original_unknown_receipt_is_bound_by_exact_raw_sha(self):
        _, _, _, receipt, _, _, pins = fixtures()
        raw = canonical(receipt) + b"\n"
        pins["unknown_receipt_sha256"] = hashlib.sha256(raw).hexdigest()
        self.assertEqual(recovery.validate_unknown_receipt(raw, pins), receipt)
        with self.assertRaises(BuildControlError):
            recovery.validate_unknown_receipt(raw + b" ", pins)

    def test_partial_receipt_cas_recovers_original_only_from_immutable_sidecar(self):
        _, _, _, receipt, _, _, pins = fixtures()
        original_raw = canonical(receipt) + b"\n"
        pins["unknown_receipt_sha256"] = hashlib.sha256(original_raw).hexdigest()
        final = {**receipt, "state": "succeeded"}
        final.pop("error")
        final_raw = canonical(final) + b"\n"
        current, original, source_raw = recovery.select_receipt_documents(
            final_raw, original_raw, pins, continuation_intent_exists=True,
        )
        self.assertEqual(current, final)
        self.assertEqual(original, receipt)
        self.assertEqual(source_raw, original_raw)
        with self.assertRaises(BuildControlError):
            recovery.select_receipt_documents(
                final_raw, original_raw, pins, continuation_intent_exists=False,
            )

    def test_backend_must_be_stopped_and_exit_zero_but_frontend_snapshot_may_be_running(self):
        identity, compose, previous, receipt, retained, record, pins = fixtures()
        retained["backend"]["State"]["ExitCode"] = 1
        with self.assertRaises(BuildControlError):
            recovery.validate_snapshot(pins, receipt, previous, compose, retained,
                                       record, identity=identity, control_volume=CONTROL_VOLUME,
                                       namespace="")
        _, compose, previous, receipt, retained, record, pins = fixtures()
        retained["frontend"]["State"].pop("Running")
        recovery.validate_snapshot(pins, receipt, previous, compose, retained, record,
                                   identity=identity, control_volume=CONTROL_VOLUME,
                                   namespace="")

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(BuildControlError):
            recovery.strict_object(b'{"attempt":"a","attempt":"b"}', "fixture")

    def test_plan_is_deterministic_and_binds_record_hashes_without_time(self):
        plan = recovery.make_plan({"operation": RECREATE, "current_sha256": "a" * 64,
                                   "inode_evidence": {"runtime_control_device_inode": "8:41"}})
        self.assertEqual(recovery.plan_sha256(plan), recovery.plan_sha256(dict(plan)))
        self.assertNotIn("created_at", plan)
        changed = dict(plan, operation=PRIOR)
        self.assertNotEqual(recovery.plan_sha256(plan), recovery.plan_sha256(changed))

    def test_published_or_baseline_record_state_is_allowed_but_conflict_is_not(self):
        original = b'{"state":"outcome-unknown-resources-retained"}\n'
        final = b'{"state":"succeeded"}\n'
        recovery.validate_publication_state(
            original, original, final, expected_sha256=hashlib.sha256(original).hexdigest()
        )
        recovery.validate_publication_state(final, original, final,
                                            expected_sha256=hashlib.sha256(original).hexdigest())
        with self.assertRaises(BuildControlError):
            recovery.validate_publication_state(b"foreign", original, final,
                                                expected_sha256=hashlib.sha256(original).hexdigest())

    def test_observer_uses_real_flock_and_releases_on_terminal_or_client_eof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempt_root = root / "recreate-services/attempts" / RECREATE
            attempt_root.mkdir(parents=True)
            attempt_root.chmod(0o750)
            (root / "active").write_text(RECREATE, encoding="ascii")
            script = recovery.observer_script(RECREATE, str(root))
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c", script], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            self.assertEqual(process.stdout.readline(), b"READY\n")
            process.stdin.write(b"LOGGED\n")
            process.stdin.flush()
            self.assertEqual(process.stdout.readline(), b"LOGGED\n")
            time.sleep(0.35)
            self.assertIsNone(process.poll(), "observer exited while its client stdin remained open")
            # Another real flock holder is excluded while the observer waits.
            contender = subprocess.run(
                ["bash", "-euo", "pipefail", "-c",
                 "exec 9>\"$1\"; flock -n 9" , "bash",
                 str(attempt_root / "interrupted-fresh-archive.lock")],
                check=False,
            )
            self.assertNotEqual(contender.returncode, 0)
            (attempt_root / "terminal.json").write_text("{}", encoding="ascii")
            self.assertEqual(process.wait(timeout=5), 0)
            process.stdin.close()
            process.stdout.close()

            (attempt_root / "terminal.json").unlink()
            process = subprocess.Popen(
                ["bash", "-euo", "pipefail", "-c", script], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            self.assertEqual(process.stdout.readline(), b"READY\n")
            process.stdin.write(b"LOGGED\n")
            process.stdin.flush()
            self.assertEqual(process.stdout.readline(), b"LOGGED\n")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
            process.stdout.close()
            contender = subprocess.run(
                ["bash", "-euo", "pipefail", "-c",
                 "exec 9>\"$1\"; flock -n 9", "bash",
                 str(attempt_root / "interrupted-fresh-archive.lock")],
                check=False,
            )
            self.assertEqual(contender.returncode, 0)

    def test_observer_lock_refuses_symlink_and_hardlink_without_touching_target(self):
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                attempt_root = root / "recreate-services/attempts" / RECREATE
                attempt_root.mkdir(parents=True)
                attempt_root.chmod(0o750)
                (root / "active").write_text(RECREATE, encoding="ascii")
                target = root / "target.bin"
                original = b"keep this unrelated receipt intact\x00\xff"
                target.write_bytes(original)
                target.chmod(0o640)
                lock = attempt_root / "interrupted-fresh-archive.lock"
                if link_kind == "symlink":
                    lock.symlink_to(target)
                else:
                    os.link(target, lock)
                process = subprocess.Popen(
                    ["bash", "-euo", "pipefail", "-c", recovery.observer_script(RECREATE, str(root))],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                )
                self.assertEqual(process.stdout.readline(), b"")
                self.assertNotEqual(process.wait(timeout=5), 0)
                process.stdin.close()
                process.stdout.close()
                self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
